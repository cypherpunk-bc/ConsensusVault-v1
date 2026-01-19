// ============================================
// ConsensusVault 前端 
// 架构：VaultManager
// ============================================

// ===== 配置部分 =====
//  BSC 主网（Chain ID: 56）
// const CONFIG = {
//     chainId: '0x38',
//     chainIdDec: 56,
//     chainName: 'BNB Chain',
//     displayName: 'BNB主网',
//     rpcUrl: 'https://bsc-dataseed.bnbchain.org',
//     explorer: 'https://bscscan.com'
// };

// BSC测试网（Chain ID: 61）

const CONFIG = {
    chainId: '0x61',
    chainIdDec: 97,
    rpcUrl: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    explorer: 'https://testnet.bscscan.com'
};


// 工厂合约地址（部署后替换）
const VAULT_FACTORY_ADDRESS = '0x9669AcaA7e427A45e5e751bB790231f779B46Adc';

// 导入 ABI
let VAULT_FACTORY_ABI = [];
let CONSENSUS_VAULT_ABI = [];
let ERC20_ABI = [];

// 扩展的 ERC20 ABI（包含 Transfer 事件和常用函数）
const ERC20_EXTENDED_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'event Transfer(address indexed from, address indexed to, uint256 value)'
];

// ===== 全局状态 =====
let provider, signer, walletAddress;
let vaultManager = null;

// 用户数据缓存
const userCache = {
    participatedVaults: [], // 用户参与的金库列表
    userEvents: []          // 用户相关的所有事件
};

// ===== VaultManager 类 - 合约交互管理 =====
class VaultManager {
    constructor(factoryAddress, provider) {
        this.factoryAddress = factoryAddress;
        this.provider = provider;
        this.factoryContract = null;
        this.vaults = new Map(); // 缓存金库实例
    }

    setFactoryContract(contract) {
        this.factoryContract = contract;
    }

    async getFactoryVaultCount() {
        try {
            return await this.factoryContract.getVaultCount();
        } catch (e) {
            console.error('获取金库数量失败:', e);
            return 0;
        }
    }

    async getVaultAddress(index) {
        try {
            return await this.factoryContract.allVaults(index);
        } catch (e) {
            console.error(`获取第 ${index} 个金库失败:`, e);
            return null;
        }
    }

    async getVaultDetails(vaultAddress) {
        try {
            const vault = new ethers.Contract(
                vaultAddress,
                CONSENSUS_VAULT_ABI,
                this.provider
            );

            const depositTokenAddr = await vault.depositToken();
            let tokenSymbol = 'TOKEN';

            // 获取 depositToken 的符号
            try {
                const tokenAbi = ['function symbol() view returns (string)'];
                const depositToken = new ethers.Contract(depositTokenAddr, tokenAbi, this.provider);
                tokenSymbol = await depositToken.symbol();
            } catch (e) {
                console.warn(`获取代币符号失败: ${e.message}`);
                tokenSymbol = 'TOKEN';
            }

            return {
                depositToken: depositTokenAddr,
                totalDeposits: await vault.totalPrincipal(),
                totalYesVotes: await vault.totalVoteWeight(),
                consensusReached: await vault.consensusReached(),
                tokenSymbol: tokenSymbol
            };
        } catch (e) {
            console.error(`获取金库详情失败 ${vaultAddress}:`, e);
            return null;
        }
    }

    async getUserVaultInfo(vaultAddress, userAddress) {
        try {
            const vault = new ethers.Contract(
                vaultAddress,
                CONSENSUS_VAULT_ABI,
                this.provider
            );
            return await vault.userInfo(userAddress);
        } catch (e) {
            console.error('获取用户金库信息失败:', e);
            return null;
        }
    }

    // 获取代币余额
    async getTokenBalance(tokenAddress, accountAddress) {
        try {
            const token = new ethers.Contract(
                tokenAddress,
                ERC20_EXTENDED_ABI,
                this.provider
            );
            return await token.balanceOf(accountAddress);
        } catch (e) {
            console.error('获取代币余额失败:', e);
            return null;
        }
    }

    // 验证链上转账（通过解析交易 receipt 中的 Transfer 事件）
    async verifyTokenTransfer(receipt, tokenAddress, expectedFrom, expectedTo, expectedAmount, balanceBefore, balanceAfter) {
        try {
            console.log('🔍 开始验证转账...');
            console.log(`   Receipt logs 数量: ${receipt.logs.length}`);

            const token = new ethers.Contract(
                tokenAddress,
                ERC20_EXTENDED_ABI,
                this.provider
            );

            // 解析所有 Transfer 事件
            const transferEvents = receipt.logs
                .filter(log => log.address.toLowerCase() === tokenAddress.toLowerCase())
                .map(log => {
                    try {
                        return token.interface.parseLog(log);
                    } catch {
                        return null;
                    }
                })
                .filter(event => event && event.name === 'Transfer');

            console.log(`🔍 找到 ${transferEvents.length} 个 Transfer 事件`);

            // 查找匹配的 Transfer 事件
            const matchedEvent = transferEvents.find(event => {
                const from = event.args.from.toLowerCase();
                const to = event.args.to.toLowerCase();
                const amount = event.args.value;

                return from === expectedFrom.toLowerCase() &&
                    to === expectedTo.toLowerCase() &&
                    amount.eq(expectedAmount);
            });

            if (matchedEvent) {
                console.log('✅ 链上转账验证成功 (事件匹配):');
                console.log(`   From: ${matchedEvent.args.from}`);
                console.log(`   To: ${matchedEvent.args.to}`);
                console.log(`   Amount: ${ethers.utils.formatEther(matchedEvent.args.value)}`);
                return true;
            } else {
                console.warn('⚠️ 未找到匹配的 Transfer 事件，检查余额变化...');
                console.log('期望的转账:', {
                    from: expectedFrom,
                    to: expectedTo,
                    amount: ethers.utils.formatEther(expectedAmount)
                });
                if (transferEvents.length > 0) {
                    console.log('实际的 Transfer 事件:', transferEvents.map(e => ({
                        from: e.args.from,
                        to: e.args.to,
                        amount: ethers.utils.formatEther(e.args.value)
                    })));
                }

                // 如果提供了余额数据，通过余额变化验证
                if (balanceBefore && balanceAfter) {
                    const actualChange = balanceAfter.sub(balanceBefore).abs();
                    const expectedChange = expectedAmount.abs();

                    if (actualChange.eq(expectedChange)) {
                        console.log('✅ 链上转账验证成功 (余额变化匹配):');
                        console.log(`   预期变化: ${ethers.utils.formatEther(expectedChange)}`);
                        console.log(`   实际变化: ${ethers.utils.formatEther(actualChange)}`);
                        return true;
                    } else {
                        console.error('❌ 余额变化不匹配!');
                        console.log(`   预期: ${ethers.utils.formatEther(expectedChange)}`);
                        console.log(`   实际: ${ethers.utils.formatEther(actualChange)}`);
                    }
                }

                return false;
            }
        } catch (e) {
            console.error('验证转账失败:', e);
            return false;
        }
    }

    async deposit(vaultAddress, amount, signer) {
        try {
            const vault = new ethers.Contract(
                vaultAddress,
                CONSENSUS_VAULT_ABI,
                signer
            );

            // 获取代币地址和用户地址
            const tokenAddress = await vault.depositToken();
            const userAddress = await signer.getAddress();
            const amountWei = ethers.utils.parseEther(amount.toString());

            // 记录存款前的余额
            const userBalanceBefore = await this.getTokenBalance(tokenAddress, userAddress);
            const vaultBalanceBefore = await this.getTokenBalance(tokenAddress, vaultAddress);

            console.log('📊 存款前余额:');
            console.log(`   用户: ${ethers.utils.formatEther(userBalanceBefore)}`);
            console.log(`   金库: ${ethers.utils.formatEther(vaultBalanceBefore)}`);

            // 执行存款
            const tx = await vault.deposit(amountWei);
            const receipt = await tx.wait();

            // 记录存款后的余额
            const userBalanceAfter = await this.getTokenBalance(tokenAddress, userAddress);
            const vaultBalanceAfter = await this.getTokenBalance(tokenAddress, vaultAddress);

            // 验证链上转账
            const transferVerified = await this.verifyTokenTransfer(
                receipt,
                tokenAddress,
                userAddress,
                vaultAddress,
                amountWei,
                userBalanceBefore,
                userBalanceAfter
            );

            console.log('📊 存款后余额:');
            console.log(`   用户: ${ethers.utils.formatEther(userBalanceAfter)}`);
            console.log(`   金库: ${ethers.utils.formatEther(vaultBalanceAfter)}`);
            console.log(`   用户变化: ${ethers.utils.formatEther(userBalanceBefore.sub(userBalanceAfter))}`);
            console.log(`   金库变化: ${ethers.utils.formatEther(vaultBalanceAfter.sub(vaultBalanceBefore))}`);

            if (transferVerified) {
                console.log('✅ 存款交易已在链上确认');
            } else {
                console.warn('⚠️ 存款交易验证异常，请检查交易详情');
            }

            return receipt;
        } catch (e) {
            throw new Error(`存款失败: ${e.message}`);
        }
    }

    async voteForConsensus(vaultAddress, signer) {
        try {
            const vault = new ethers.Contract(
                vaultAddress,
                CONSENSUS_VAULT_ABI,
                signer
            );
            const tx = await vault.voteForConsensus();
            return await tx.wait();
        } catch (e) {
            throw new Error(`投票失败: ${e.message}`);
        }
    }

    async withdrawAll(vaultAddress, signer) {
        try {
            const vault = new ethers.Contract(
                vaultAddress,
                CONSENSUS_VAULT_ABI,
                signer
            );

            // 获取代币地址和用户地址
            const tokenAddress = await vault.depositToken();
            const userAddress = await signer.getAddress();

            // 获取预期提现金额（手动计算 pendingReward）
            const userInfo = await vault.userInfo(userAddress);
            const accRewardPerShare = await vault.accRewardPerShare();
            const PRECISION = ethers.BigNumber.from('1000000000000'); // 1e12
            const pendingReward = userInfo.principal.mul(accRewardPerShare).div(PRECISION).sub(userInfo.rewardDebt);
            const vaultBalanceBefore = await this.getTokenBalance(tokenAddress, vaultAddress);

            console.log('📊 提现前余额:');
            console.log(`   用户: ${ethers.utils.formatEther(userBalanceBefore)}`);
            console.log(`   金库: ${ethers.utils.formatEther(vaultBalanceBefore)}`);
            console.log(`   预期提现: ${ethers.utils.formatEther(expectedAmount)} (本金 ${ethers.utils.formatEther(userInfo.principal)} + 收益 ${ethers.utils.formatEther(pendingReward)})`);

            // 执行提现
            const tx = await vault.withdrawAll();
            const receipt = await tx.wait();

            // 记录提现后的余额
            const userBalanceAfter = await this.getTokenBalance(tokenAddress, userAddress);
            const vaultBalanceAfter = await this.getTokenBalance(tokenAddress, vaultAddress);

            // 验证链上转账
            const transferVerified = await this.verifyTokenTransfer(
                receipt,
                tokenAddress,
                vaultAddress,
                userAddress,
                expectedAmount,
                vaultBalanceBefore,
                vaultBalanceAfter
            );
            console.log(`   用户变化: +${ethers.utils.formatEther(userBalanceAfter.sub(userBalanceBefore))}`);
            console.log(`   金库变化: -${ethers.utils.formatEther(vaultBalanceBefore.sub(vaultBalanceAfter))}`);

            if (transferVerified) {
                console.log('✅ 提现交易已在链上确认');
            } else {
                console.warn('⚠️ 提现交易验证异常，请检查交易详情');
            }

            return receipt;
        } catch (e) {
            throw new Error(`提现失败: ${e.message}`);
        }
    }

    // 根据代币地址查找金库
    async getVaultForToken(tokenAddress) {
        try {
            return await this.factoryContract.getVault(tokenAddress);
        } catch (e) {
            console.error('查询金库失败:', e);
            return ethers.constants.AddressZero;
        }
    }

    // 创建金库（新版本：必须同时存入代币，自动读取symbol）
    async createVault(tokenAddress, initialDeposit, signer) {
        try {
            // 确保地址格式正确，避免ENS解析
            const checksumAddress = ethers.utils.getAddress(tokenAddress);
            const factory = this.factoryContract.connect(signer);

            // 先approve代币给factory
            const tokenContract = new ethers.Contract(
                checksumAddress,
                ['function approve(address spender, uint256 amount) returns (bool)'],
                signer
            );
            const approveTx = await tokenContract.approve(factory.address, initialDeposit);
            await approveTx.wait();

            // 调用createVaultAndDeposit（合约会自动读取代币symbol）
            const tx = await factory.createVaultAndDeposit(
                checksumAddress,
                initialDeposit
            );
            const receipt = await tx.wait();

            // 从event中提取新金库地址
            let vaultAddress = null;
            if (receipt && receipt.events) {
                const event = receipt.events.find(e => e.event === 'VaultCreated');
                if (event && event.args) {
                    vaultAddress = event.args.vault;
                }
            }

            // 如果没有从event获取到，尝试通过token查询
            if (!vaultAddress || vaultAddress === ethers.constants.AddressZero) {
                vaultAddress = await this.getVaultForToken(tokenAddress);
            }

            return { tx, receipt, vaultAddress };
        } catch (e) {
            throw new Error(`创建金库失败: ${e.message}`);
        }
    }
}


// ===== 初始化函数 =====
async function init() {
    try {
        // 1. 加载 ABI
        await loadABIs();

        // 2. 初始化 provider（硬编码为 BSC 主网）
        if (typeof window.ethereum !== 'undefined') {
            provider = new ethers.providers.Web3Provider(window.ethereum, {
                chainId: 56,
                name: 'bsc',
                ensAddress: null
            });
        } else {
            provider = new ethers.providers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org');
        }

        // 3. 初始化管理器
        vaultManager = new VaultManager(VAULT_FACTORY_ADDRESS, provider);

        // 4. 设置事件监听器
        setupEventListeners();

        // 5. 尝试自动连接钱包
        try {
            const accounts = await window.ethereum.request({ method: 'eth_accounts' });
            if (accounts && accounts.length > 0) {
                await connectWallet();
            }
        } catch (e) {
            // 无钱包或用户未授权
        }

        // 6. 加载初始数据
        await loadAllVaults();

    } catch (error) {
        console.error('初始化错误:', error);
        showModal('初始化错误', error.message);
    }
}

async function loadABIs() {
    try {
        const factoryRes = await fetch('./abi/ConsensusVaultFactory.json');
        const vaultRes = await fetch('./abi/ConsensusVault.json');

        const factoryData = await factoryRes.json();
        const vaultData = await vaultRes.json();

        // 处理 ABI 格式：
        // 1. {abi: [...]} 格式
        // 2. {contractName: "...", abi: [...]} 格式
        // 3. [...] 直接数组格式
        VAULT_FACTORY_ABI = factoryData.abi || factoryData;
        CONSENSUS_VAULT_ABI = vaultData.abi || vaultData;

        // 基础 ERC20 ABI（简化版）
        ERC20_ABI = [
            'function balanceOf(address owner) public view returns (uint256)',
            'function approve(address spender, uint256 amount) public returns (bool)',
            'function transfer(address to, uint256 amount) public returns (bool)'
        ];
    } catch (error) {
        console.error('加载 ABI 失败:', error);
    }
}

async function connectWallet() {
    try {
        const accounts = await window.ethereum.request({
            method: 'eth_requestAccounts'
        });
        walletAddress = accounts[0];
        signer = provider.getSigner();

        updateUI();

        // 加载用户参与的金库
        await loadUserVaults();

    } catch (error) {
        console.error('连接钱包失败:', error);
        showModal('连接失败', error.message);
    }
}

async function loadAllVaults() {
    try {
        if (!VAULT_FACTORY_ABI.length) return;

        const factoryContract = new ethers.Contract(
            VAULT_FACTORY_ADDRESS,
            VAULT_FACTORY_ABI,
            provider
        );
        vaultManager.setFactoryContract(factoryContract);

        const countBN = await vaultManager.getFactoryVaultCount();
        const count = parseInt(countBN.toString());

        allVaults = [];
        const loadLimit = Math.min(count, 50);

        for (let i = 0; i < loadLimit; i++) {
            try {
                const vaultAddr = await vaultManager.getVaultAddress(i);
                if (vaultAddr) {
                    const details = await vaultManager.getVaultDetails(vaultAddr);
                    allVaults.push({
                        address: vaultAddr,
                        ...details,
                        blockNumber: i,
                        totalDepositsFormatted: ethers.utils.formatEther(details.totalDeposits),
                        totalYesVotesFormatted: ethers.utils.formatEther(details.totalYesVotes),
                        tokenSymbol: details.tokenSymbol || 'TOKEN'
                    });
                }
            } catch (err) {
                console.warn('加载金库失败:', err.message);
            }
        }

        // 初始化无限滚动
        filteredVaults = sortVaults(allVaults, currentSort);
        currentPage = 0;
        loadMoreVaults();

    } catch (error) {
        console.error('[loadAllVaults] 加载金库失败:', error);
        throw error;
    }
}

async function loadUserVaults() {
    if (!walletAddress) return;

    try {
        userCache.participatedVaults = [];

        const factoryContract = new ethers.Contract(
            VAULT_FACTORY_ADDRESS,
            VAULT_FACTORY_ABI,
            provider
        );
        vaultManager.setFactoryContract(factoryContract);

        const count = await vaultManager.getFactoryVaultCount();

        for (let i = 0; i < count; i++) {
            const vaultAddr = await vaultManager.getVaultAddress(i);
            if (vaultAddr) {
                const userInfo = await vaultManager.getUserVaultInfo(vaultAddr, walletAddress);
                const principal = userInfo ? userInfo.principal || userInfo[0] : null;
                if (principal && principal.gt(0)) {
                    const details = await vaultManager.getVaultDetails(vaultAddr);
                    userCache.participatedVaults.push({
                        address: vaultAddr,
                        depositAmount: ethers.utils.formatEther(principal),
                        consensusReached: details ? details.consensusReached : false,
                        tokenSymbol: details ? details.tokenSymbol : 'TOKEN'
                    });
                }
            }
        }

        renderUserVaults();
    } catch (error) {
        console.error('加载用户金库失败:', error);
    }
}

// ===== UI 更新函数 =====
function updateUI() {
    const walletBtn = document.getElementById('connectButton');

    if (walletBtn) {
        if (walletAddress) {
            const shortAddr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
            walletBtn.textContent = `已连接: ${shortAddr}`;
            walletBtn.classList.add('connected');
        } else {
            // 钱包已断开
            walletBtn.textContent = '连接钱包';
            walletBtn.classList.remove('connected');
        }
    }
}

function renderUserVaults() {
    const grid = document.getElementById('userVaultsGrid');
    if (!grid || !walletAddress) return;

    if (userCache.participatedVaults.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>未参与任何金库</p>
                <p class="text-muted">连接钱包或在"探索"中创建/参与金库</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = '';
    userCache.participatedVaults.forEach(vault => {
        const card = document.createElement('div');
        card.className = 'vault-card user-vault';
        const status = vault.consensusReached ? '已解锁' : '锁定中';
        const statusClass = vault.consensusReached ? 'status-unlocked' : 'status-active';
        const statusIcon = vault.consensusReached ? 'fa-unlock' : 'fa-lock';
        card.innerHTML = `
            <div class="card-header">
                <h3>${vault.tokenSymbol || 'TOKEN'}</h3>
                <span class="status-badge ${statusClass}"><i class="fas ${statusIcon}"></i> ${status}</span>
            </div>
            <div class="card-body">
                <div class="info-row">
                    <span class="label">我的存款</span>
                    <span class="value">${parseFloat(vault.depositAmount).toFixed(4)} ${vault.tokenSymbol || 'TOKEN'}</span>
                </div>
                <div class="info-row">
                    <span class="label">金库地址</span>
                    <span class="value" style="font-family: monospace; font-size: 12px;">${vault.address.slice(0, 10)}...${vault.address.slice(-8)}</span>
                </div>
            </div>
            <div class="card-footer">
                <button class="btn btn-small" onclick="goToVaultDetail('${vault.address}')">
                    <i class="fas fa-arrow-right"></i> 进入管理
                </button>
            </div>
        `;
        grid.appendChild(card);
    });
}

function setupEventListeners() {
    const connectBtn = document.getElementById('connectButton');
    const navTabs = document.querySelectorAll('.tab');
    const createVaultBtn = document.getElementById('createVaultBtn');
    const filterType = document.getElementById('filterType');
    const sortOrder = document.getElementById('sortOrder');
    const modalClose = document.querySelector('.modal-close');

    // 连接钱包按钮
    if (connectBtn) {
        connectBtn.addEventListener('click', () => {
            if (walletAddress) {
                walletAddress = null;
                signer = null;
                userCache.participatedVaults = [];
                updateUI();
                showModal('已断开', '钱包已断开连接');
            } else {
                connectWallet();
            }
        });
    }

    // 导航标签
    navTabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            const view = tab.dataset.view;
            switchView(view);
        });
    });

    // 创建金库按钮
    if (createVaultBtn) {
        createVaultBtn.addEventListener('click', async () => {
            if (!walletAddress) {
                showModal('未连接钱包', '请先连接钱包');
                return;
            }
            const tokenAddr = document.getElementById('createTokenInput').value.trim();
            const depositAmount = document.getElementById('createDepositInput')?.value.trim() || '';

            if (!tokenAddr || tokenAddr.length < 42) {
                showModal('输入错误', '请输入有效的代币地址');
                return;
            }

            if (!ethers.utils.isAddress(tokenAddr)) {
                showModal('地址无效', '请输入正确的以太坊地址格式');
                return;
            }

            if (!depositAmount || parseFloat(depositAmount) <= 0) {
                showModal('输入错误', '请输入初始存款数量（必须 > 0）');
                return;
            }

            try {
                showLoading('创建金库中，请在钱包确认交易...');
                const depositWei = ethers.utils.parseEther(depositAmount);
                const result = await vaultManager.createVault(tokenAddr, depositWei, signer);

                hideLoading();

                if (result.vaultAddress && result.vaultAddress !== ethers.constants.AddressZero) {
                    showModal('创建成功', `金库已创建！`);
                    setTimeout(() => {
                        goToVaultDetail(result.vaultAddress);
                    }, 1500);
                } else {
                    showModal('创建成功', '金库已创建，请稍后在列表中查看');
                    // 刷新金库列表
                    setTimeout(() => {
                        init();
                    }, 2000);
                }
            } catch (error) {
                hideLoading();
                console.error('创建金库失败:', error);

                // 解析具体错误信息
                let errorMessage = '创建金库时发生错误';
                if (error.message) {
                    if (error.message.includes('Last epoch still active')) {
                        errorMessage = '该代币还有未解锁金库，不能创建新的金库';
                    } else if (error.message.includes('user rejected') || error.message.includes('User denied')) {
                        errorMessage = '您取消了交易';
                    } else if (error.message.includes('Vault already exists')) {
                        errorMessage = '该代币的金库已经存在';
                    } else if (error.message.includes('insufficient funds')) {
                        errorMessage = '账户余额不足，无法支付gas费用';
                    } else {
                        errorMessage = error.message;
                    }
                }

                showModal('创建失败', errorMessage);
            }
        });
    }

    // 活动过滤和排序
    if (filterType) {
        filterType.addEventListener('change', (e) => {
            activityFeed.filterType = e.target.value;
            activityFeed.render('activityBody');
        });
    }

    if (sortOrder) {
        sortOrder.addEventListener('change', (e) => {
            activityFeed.sortOrder = e.target.value;
            activityFeed.render('activityBody');
        });
    }

    // 模态框关闭
    if (modalClose) {
        modalClose.addEventListener('click', () => {
            const overlay = document.getElementById('modalOverlay');
            if (overlay) overlay.style.display = 'none';
        });
    }
}

function switchView(view) {
    const views = document.querySelectorAll('.view');
    const tabs = document.querySelectorAll('.tab');

    views.forEach(v => v.classList.remove('active'));
    tabs.forEach(t => t.classList.remove('active'));

    const activeView = document.getElementById(`view-${view}`);
    const activeTab = document.querySelector(`[data-view="${view}"]`);

    if (activeView) activeView.classList.add('active');
    if (activeTab) activeTab.classList.add('active');

    // 切换到"我的金库"时刷新数据
    if (view === 'vaults') {
        loadUserVaults();
    }
}

function showModal(title, message) {
    const overlay = document.getElementById('modalOverlay');
    if (!overlay) return;

    const titleEl = overlay.querySelector('.modal-title');
    const bodyEl = overlay.querySelector('.modal-body');

    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.textContent = message;

    overlay.style.display = 'block';

    const closeBtn = overlay.querySelector('.modal-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            overlay.style.display = 'none';
        });
    }
}

// ===== 页面加载 =====
window.addEventListener('load', () => {
    init();
});

// ===== 全局函数导出 =====
window.switchView = switchView;
window.connectWallet = connectWallet;
window.goToVaultDetail = goToVaultDetail;

// 导航到金库详情页
function goToVaultDetail(vaultAddress) {
    // 存储选中的金库地址到 sessionStorage
    sessionStorage.setItem('selectedVault', vaultAddress);

    // 生产环境配置：如果设置了VAULT_DOMAIN_TEMPLATE，使用独立域名
    // 例如: VAULT_DOMAIN_TEMPLATE = 'https://{address}.vaults.example.com'
    const domainTemplate = window.VAULT_DOMAIN_TEMPLATE || null;

    if (domainTemplate && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        // 生产环境：跳转到金库独立域名
        const vaultUrl = domainTemplate.replace('{address}', vaultAddress.toLowerCase());
        window.location.href = vaultUrl;
    } else {
        // 开发/测试环境：使用相对路径
        window.location.href = `vault.html?vault=${vaultAddress}`;
    }
}

// 显示加载动画
function showLoading(text = '处理中...') {
    const overlay = document.getElementById('loadingOverlay');
    const textEl = document.getElementById('loadingText');
    if (overlay) {
        if (textEl) textEl.textContent = text;
        overlay.style.display = 'flex';
    }
}

// 隐藏加载动画
function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
}

// ===== 无限滚动和排序功能 =====
let allVaults = [];
let filteredVaults = [];
let currentSort = 'newest';
let currentPage = 0;
const PAGE_SIZE = 12;

// 排序金库
function sortVaults(vaults, method) {
    const sorted = [...vaults];

    switch (method) {
        case 'newest':
            // 按区块号倒序（最新创建优先）
            sorted.sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0));
            break;

        case 'progress':
            // 按共识进度倒序
            sorted.sort((a, b) => {
                const progressA = a.totalDeposits > 0 ? (a.totalYesVotes / a.totalDeposits) : 0;
                const progressB = b.totalDeposits > 0 ? (b.totalYesVotes / b.totalDeposits) : 0;
                return progressB - progressA;
            });
            break;
    }

    return sorted;
}

// 加载更多金库（无限滚动）
function loadMoreVaults() {
    const grid = document.getElementById('vaultsGrid');
    const loadingMore = document.getElementById('loadingMore');

    if (!grid) return;

    const start = currentPage * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const vaultsToShow = filteredVaults.slice(start, end);

    if (vaultsToShow.length === 0) return;

    if (loadingMore) loadingMore.style.display = 'none';

    if (currentPage === 0) {
        grid.innerHTML = '';
    }

    vaultsToShow.forEach(vault => {
        grid.appendChild(createVaultCard(vault));
    });

    currentPage++;

    // 如果还有更多金库，显示加载指示器
    if (end < filteredVaults.length) {
        if (loadingMore) loadingMore.style.display = 'flex';
    }
}

// 创建金库卡片
function createVaultCard(vault) {
    const div = document.createElement('div');
    div.className = 'vault-card';

    // 如果金库已解锁，进度显示 100%
    const totalDepositsNum = parseFloat(vault.totalDepositsFormatted || 0);
    const totalYesVotesNum = parseFloat(vault.totalYesVotesFormatted || 0);
    const progress = vault.consensusReached
        ? 100
        : (totalDepositsNum > 0 ? (totalYesVotesNum / totalDepositsNum * 100) : 0);
    const status = vault.consensusReached ? '已解锁' : '锁定中';
    const statusClass = vault.consensusReached ? 'status-unlocked' : 'status-active';

    div.innerHTML = `
        <div class="card-header">
            <h3>${vault.tokenSymbol || 'VAULT'}</h3>
            <span class="status-badge ${statusClass}">${status}</span>
        </div>
        <div class="card-body">
            <div class="info-row">
                <span class="label">总存款</span>
                <span class="value">${parseFloat(vault.totalDepositsFormatted).toFixed(4)} ${vault.tokenSymbol || 'TOKEN'}</span>
            </div>
            <div class="info-row">
                <span class="label">赞成票</span>
                <span class="value">${parseFloat(vault.totalYesVotesFormatted).toFixed(4)}</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${Math.min(progress, 100)}%"></div>
            </div>
            <div class="progress-text">${progress.toFixed(1)}% 共识进度</div>
        </div>
        <div class="card-footer">
            <button class="btn btn-small" onclick="goToVaultDetail('${vault.address}')">
                <i class="fas fa-arrow-right"></i> 进入
            </button>
        </div>
    `;

    return div;
}

// 搜索功能
async function searchVault() {
    const searchTerm = document.getElementById('searchInput')?.value.trim();

    if (!searchTerm) {
        showModal('错误', '请输入金库地址或代币地址');
        return;
    }

    if (!ethers.utils.isAddress(searchTerm)) {
        showModal('错误', '请输入有效的以太坊地址');
        return;
    }

    try {
        showLoading('搜索中...');

        // 1. 先检查是否是金库地址
        try {
            const vaultContract = new ethers.Contract(
                searchTerm,
                CONSENSUS_VAULT_ABI,
                provider
            );
            const depositToken = await vaultContract.depositToken();
            if (depositToken && depositToken !== ethers.constants.AddressZero) {
                goToVaultDetail(searchTerm);
                return;
            }
        } catch (e) {
            // 不是金库地址，继续尝试作为代币地址搜索
        }

        // 2. 作为代币地址，搜索所有相关金库
        const matchingVaults = allVaults.filter(v =>
            v.depositToken.toLowerCase() === searchTerm.toLowerCase()
        );

        if (matchingVaults.length === 0) {
            showModal('未找到', `没有找到代币 ${searchTerm.slice(0, 10)}... 的相关金库`);
            return;
        }

        // 3. 优先找未解锁的金库（当前活跃期）
        const activeVault = matchingVaults.find(v => !v.consensusReached);

        if (activeVault) {
            goToVaultDetail(activeVault.address);
        } else {
            // 所有金库都已解锁，提示用户可以创建新一期
            showModal('提示', `${matchingVaults[0].tokenSymbol} 的所有金库都已解锁，您可以创建新一期金库`);
        }

    } catch (error) {
        console.error('搜索失败:', error);
        showModal('搜索失败', error.message);
    } finally {
        hideLoading();
    }
}

// 监听无限滚动
window.addEventListener('scroll', () => {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight;
    const winHeight = window.innerHeight;

    // 距离底部 500px 时加载更多
    if (scrollTop + winHeight >= docHeight - 500) {
        const loadingMore = document.getElementById('loadingMore');
        if (loadingMore && loadingMore.style.display === 'flex') {
            loadMoreVaults();
        }
    }
});

// 绑定搜索按钮和排序选择
document.addEventListener('DOMContentLoaded', () => {
    // 搜索功能
    document.getElementById('searchBtn')?.addEventListener('click', searchVault);
    document.getElementById('searchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchVault();
    });

    // 排序功能
    document.getElementById('sortSelect')?.addEventListener('change', (e) => {
        currentSort = e.target.value;
        currentPage = 0;
        filteredVaults = sortVaults(allVaults, currentSort);
        loadMoreVaults();
    });
});

// 导出到全局
window.searchVault = searchVault;
window.goToVaultDetail = goToVaultDetail;


