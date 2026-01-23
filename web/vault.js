// ============================================
// ConsensusVault 金库详情页 - vault.js
// ============================================

// ===== 配置 =====
// BSC测试网（Chain ID: 97）
const CONFIG = {
    chainId: '0x61',
    chainIdDec: 97,
    rpcUrl: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    explorer: 'https://testnet.bscscan.com'
};

const VAULT_FACTORY_ADDRESS = '0xc9FA3e06A09a5b6257546C6eB8De2868275A2f98';

// ===== 全局状态 =====
let provider, signer, walletAddress;
let vaultAddress = null;
let currentNetwork = 'testnet'; // 当前网络：'mainnet' 或 'testnet'
let VAULT_FACTORY_ABI = [];
let CONSENSUS_VAULT_ABI = [];

// 扩展的 ERC20 ABI（包含 Transfer 事件和常用函数）
const ERC20_EXTENDED_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'event Transfer(address indexed from, address indexed to, uint256 value)'
];

// ===== 钱包检测函数 =====
/**
 * 钱包检测配置（按优先级排序）
 */
const WALLET_PRIORITY = [
    {
        name: 'OKX (okxwallet)',
        check: () => typeof window.okxwallet !== 'undefined',
        getProvider: () => window.okxwallet
    },
    {
        name: 'OKX (okexchain)',
        check: () => typeof window.okexchain !== 'undefined',
        getProvider: () => window.okexchain
    },
    {
        name: 'OKX',
        check: () => window.ethereum?.isOKX || window.ethereum?.isOkxWallet,
        getProvider: () => window.ethereum
    },
    {
        name: 'Binance Chain Wallet',
        check: () => typeof window.BinanceChain !== 'undefined',
        getProvider: () => window.BinanceChain
    },
    {
        name: 'Binance',
        check: () => window.ethereum?.isBinance || window.ethereum?.isBinanceWallet,
        getProvider: () => window.ethereum
    },
    {
        name: 'MetaMask',
        check: () => window.ethereum?.isMetaMask,
        getProvider: () => window.ethereum
    },
    {
        name: 'Rabby',
        check: () => window.ethereum?.isRabby,
        getProvider: () => window.ethereum
    },
    {
        name: 'Generic EIP-1193',
        check: () => typeof window.ethereum !== 'undefined',
        getProvider: () => window.ethereum
    },
];

/**
 * 检测并返回可用的钱包提供者
 * 支持 MetaMask、OKX Wallet 等多种钱包
 */
function getWalletProvider() {
    for (const wallet of WALLET_PRIORITY) {
        if (wallet.check()) {
            console.log(`✓ 检测到 ${wallet.name} 钱包`);
            return wallet.getProvider();
        }
    }
    console.warn('⚠ 未检测到任何钱包');
    return null;
}

/**
 * 检查钱包是否可用
 */
function isWalletAvailable() {
    const provider = getWalletProvider();
    return provider !== null;
}

// ===== 辅助函数 =====
function formatPrecise(num) {
    // 显示完整精度，移除尾部0
    return parseFloat(num.toFixed(18)).toString();
}

function formatTimestamp(tsSeconds) {
    if (!tsSeconds || tsSeconds <= 0) return '未达成共识';
    const date = new Date(tsSeconds * 1000);
    return date.toLocaleString();
}

// ===== 价格查询功能（DexScreener API） =====
// 价格缓存
const priceCache = new Map();
const PRICE_CACHE_TTL = 10000; // 10秒缓存（充分利用 300次/分钟的限制）

/**
 * 根据链ID获取DexScreener的chainId
 * @param {number} chainIdDec - 链ID（十进制）
 * @returns {string} DexScreener chainId
 */
function getDexScreenerChainId(chainIdDec) {
    if (chainIdDec === 56) return 'bsc';
    if (chainIdDec === 97) return 'bsc-testnet';
    return 'bsc'; // 默认BSC主网
}

/**
 * 选择最佳交易对（优先USDT，选择流动性最高的）
 * @param {Array} pairs - 交易对数组
 * @returns {Object|null} 最佳交易对
 */
function selectBestPair(pairs) {
    if (!pairs || pairs.length === 0) return null;

    // 1. 过滤出 USDT 交易对
    const usdtPairs = pairs.filter(p => {
        const quoteSymbol = p.quoteToken?.symbol?.toUpperCase();
        const baseSymbol = p.baseToken?.symbol?.toUpperCase();
        return quoteSymbol === 'USDT' || baseSymbol === 'USDT';
    });

    if (usdtPairs.length > 0) {
        // 选择流动性最高的 USDT 交易对
        return usdtPairs.sort((a, b) => {
            const liquidityA = parseFloat(a.liquidity?.usd || 0);
            const liquidityB = parseFloat(b.liquidity?.usd || 0);
            return liquidityB - liquidityA;
        })[0];
    }

    // 2. 如果没有 USDT，选择 BNB 交易对（需要额外转换，暂时返回null）
    return null;
}

/**
 * 获取代币价格（通过 DexScreener API）
 * @param {string} tokenAddress - 代币合约地址
 * @param {string} chainId - 链ID ('bsc' 或 'bsc-testnet')，可选，默认从CONFIG获取
 * @returns {Promise<{price: number, change24h: number} | null>}
 */
async function getTokenPrice(tokenAddress, chainId = null) {
    if (!tokenAddress) return null;

    const cacheKey = tokenAddress.toLowerCase();
    const now = Date.now();

    // 检查缓存
    if (priceCache.has(cacheKey)) {
        const cached = priceCache.get(cacheKey);
        if (now - cached.timestamp < PRICE_CACHE_TTL) {
            return cached.data;
        }
    }

    try {
        // 确定 chainId
        const dexChainId = chainId || getDexScreenerChainId(CONFIG.chainIdDec);
        const url = `https://api.dexscreener.com/token-pairs/v1/${dexChainId}/${tokenAddress}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

        const response = await fetch(url, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`DexScreener API 请求失败: ${response.status}`);
            return null;
        }

        const data = await response.json();
        const bestPair = selectBestPair(data.pairs);

        if (!bestPair || !bestPair.priceUsd) {
            return null;
        }

        const priceData = {
            price: parseFloat(bestPair.priceUsd),
            change24h: bestPair.priceChange?.h24 || 0
        };

        // 更新缓存
        priceCache.set(cacheKey, {
            data: priceData,
            timestamp: now
        });

        return priceData;
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn(`获取代币价格超时: ${tokenAddress}`);
        } else {
            console.warn(`获取代币价格失败: ${tokenAddress}`, error);
        }
        return null;
    }
}

/**
 * 格式化货币显示
 * @param {number} value - 数值
 * @returns {string} 格式化的货币字符串
 */
function formatCurrency(value) {
    if (isNaN(value) || value === null || value === undefined) {
        return 'N/A';
    }

    if (value >= 1000000) {
        return `$${(value / 1000000).toFixed(2)}M`;
    } else if (value >= 1000) {
        return `$${(value / 1000).toFixed(2)}K`;
    } else if (value >= 0.01) {
        return `$${value.toFixed(2)}`;
    } else if (value > 0) {
        return `$${value.toFixed(6)}`;
    } else {
        return '$0.00';
    }
}

/**
 * 计算总市值
 * @param {string|number} totalDeposits - 总存款数量（已格式化的字符串或数字）
 * @param {number} tokenPriceUSD - 代币 USD 价格
 * @returns {string} 格式化的市值字符串，如 "$12,345.67"
 */
function calculateTotalValue(totalDeposits, tokenPriceUSD) {
    if (!tokenPriceUSD || !totalDeposits) return 'N/A';
    const depositsNum = parseFloat(totalDeposits);
    if (isNaN(depositsNum) || depositsNum === 0) return '$0.00';
    const totalValue = depositsNum * tokenPriceUSD;
    return formatCurrency(totalValue);
}

// ===== 代币小数位数处理工具 =====
// 代币小数位数缓存（避免重复查询）
const tokenDecimalsCache = new Map();

/**
 * 获取代币的小数位数
 * @param {string} tokenAddress - 代币合约地址
 * @param {ethers.Provider} provider - ethers provider
 * @returns {Promise<number>} 代币小数位数，默认18
 */
async function getTokenDecimals(tokenAddress, provider) {
    if (!tokenAddress || !provider) {
        return 18; // 默认18位小数
    }

    const cacheKey = tokenAddress.toLowerCase();
    if (tokenDecimalsCache.has(cacheKey)) {
        return tokenDecimalsCache.get(cacheKey);
    }

    try {
        const token = new ethers.Contract(
            tokenAddress,
            ERC20_EXTENDED_ABI,
            provider
        );
        const decimals = await token.decimals();
        tokenDecimalsCache.set(cacheKey, decimals);
        return decimals;
    } catch (e) {
        console.warn(`获取代币 ${tokenAddress} 小数位数失败，使用默认值18:`, e.message);
        tokenDecimalsCache.set(cacheKey, 18);
        return 18;
    }
}

/**
 * 根据代币小数位数格式化代币数量
 * @param {ethers.BigNumber} amount - 代币数量（wei格式）
 * @param {number} decimals - 代币小数位数
 * @returns {string} 格式化后的代币数量字符串
 */
function formatTokenAmount(amount, decimals) {
    if (!amount || amount.isZero()) {
        return '0';
    }
    const divisor = ethers.BigNumber.from(10).pow(decimals);
    const quotient = amount.div(divisor);
    const remainder = amount.mod(divisor);

    if (remainder.isZero()) {
        return quotient.toString();
    }

    // 处理小数部分
    const remainderStr = remainder.toString().padStart(decimals, '0');
    const trimmed = remainderStr.replace(/0+$/, '');
    if (trimmed === '') {
        return quotient.toString();
    }

    return `${quotient.toString()}.${trimmed}`;
}

/**
 * 根据代币小数位数解析代币数量
 * @param {string} amount - 代币数量字符串（如 "1.5"）
 * @param {number} decimals - 代币小数位数
 * @returns {ethers.BigNumber} 解析后的代币数量（wei格式）
 */
function parseTokenAmount(amount, decimals) {
    if (!amount || amount === '0') {
        return ethers.BigNumber.from(0);
    }

    const parts = amount.split('.');
    const integerPart = parts[0] || '0';
    const decimalPart = parts[1] || '';

    // 确保小数部分不超过代币的小数位数
    const trimmedDecimal = decimalPart.slice(0, decimals).padEnd(decimals, '0');
    const fullAmount = integerPart + trimmedDecimal;

    return ethers.BigNumber.from(fullAmount);
}

// 获取代币余额
async function getTokenBalance(tokenAddress, accountAddress) {
    try {
        const token = new ethers.Contract(
            tokenAddress,
            ERC20_EXTENDED_ABI,
            provider
        );
        return await token.balanceOf(accountAddress);
    } catch (e) {
        console.error('获取代币余额失败:', e);
        return null;
    }
}

// 验证链上转账（通过解析交易 receipt 中的 Transfer 事件）
async function verifyTokenTransfer(receipt, tokenAddress, expectedFrom, expectedTo, expectedAmount, balanceBefore, balanceAfter) {
    try {
        console.log('🔍 开始验证转账...');
        console.log(`   Receipt logs 数量: ${receipt.logs.length}`);
        console.log(`   代币地址: ${tokenAddress}`);

        const token = new ethers.Contract(
            tokenAddress,
            ERC20_EXTENDED_ABI,
            provider
        );

        // 获取代币小数位数
        const decimals = await getTokenDecimals(tokenAddress, provider);

        // 解析所有 Transfer 事件
        console.log('🔍 解析 Transfer 事件...');
        const allLogs = receipt.logs.map((log, idx) => {
            console.log(`   Log ${idx}: address=${log.address}, topics=${log.topics.length}`);
            return log;
        });

        const transferEvents = receipt.logs
            .filter(log => {
                const match = log.address.toLowerCase() === tokenAddress.toLowerCase();
                if (!match) {
                    console.log(`   跳过 log: ${log.address} != ${tokenAddress}`);
                }
                return match;
            })
            .map(log => {
                try {
                    const parsed = token.interface.parseLog(log);
                    console.log(`   解析成功: ${parsed.name}`);
                    return parsed;
                } catch (e) {
                    console.log(`   解析失败: ${e.message}`);
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
            console.log(`   Amount: ${formatTokenAmount(matchedEvent.args.value, decimals)}`);
            return true;
        } else {
            console.warn('⚠️ 未找到匹配的 Transfer 事件，检查余额变化...');
            console.log('期望的转账:', {
                from: expectedFrom,
                to: expectedTo,
                amount: formatTokenAmount(expectedAmount, decimals)
            });
            if (transferEvents.length > 0) {
                console.log('实际的 Transfer 事件:', transferEvents.map(e => ({
                    from: e.args.from,
                    to: e.args.to,
                    amount: formatTokenAmount(e.args.value, decimals)
                })));
            }

            // 如果提供了余额数据，通过余额变化验证
            if (balanceBefore && balanceAfter) {
                const actualChange = balanceAfter.sub(balanceBefore).abs();
                const expectedChange = expectedAmount.abs();

                if (actualChange.eq(expectedChange)) {
                    console.log('✅ 链上转账验证成功 (余额变化匹配):');
                    console.log(`   预期变化: ${formatTokenAmount(expectedChange, decimals)}`);
                    console.log(`   实际变化: ${formatTokenAmount(actualChange, decimals)}`);
                    return true;
                } else {
                    console.error('❌ 余额变化不匹配!');
                    console.log(`   预期: ${formatTokenAmount(expectedChange, decimals)}`);
                    console.log(`   实际: ${formatTokenAmount(actualChange, decimals)}`);
                }
            }

        }
    } catch (e) {
        console.error('验证转账失败:', e);
        return false;
    }
}

// ===== 初始化函数 =====
async function init() {
    try {
        console.log('=== 初始化 vault.js ===');

        // 1. 获取金库地址
        const params = new URLSearchParams(window.location.search);
        vaultAddress = params.get('vault') || sessionStorage.getItem('selectedVault');

        if (!vaultAddress || !ethers.utils.isAddress(vaultAddress)) {
            showModal('找不到金库', '金库地址无效，请从主页选择金库进入');
            document.getElementById('vaultAddress').textContent = '未提供有效地址';
            return;
        }

        console.log('✓ 金库地址:', vaultAddress);
        document.getElementById('vaultAddress').textContent = vaultAddress;

        // 2. 加载 ABI
        await loadABIs();

        // 3. 初始化 Provider
        const walletProvider = getWalletProvider();
        if (walletProvider) {
            provider = new ethers.providers.Web3Provider(walletProvider, 'any');
            console.log('✓ Web3Provider 初始化完成');
            console.log('当前域名:', window.location.origin);
            console.log('当前协议:', window.location.protocol);

            // 设置事件监听
            setupEventListeners();

            // 尝试自动连接钱包
            try {
                const accounts = await walletProvider.request({ method: 'eth_accounts' });
                if (accounts && accounts.length > 0) {
                    walletAddress = accounts[0];
                    signer = provider.getSigner();
                    console.log('✓ 自动连接钱包:', walletAddress);
                    updateUI();
                }
            } catch (e) {
                console.log('用户未授权钱包:', e.message);
            }
        } else {
            // 只读模式：使用公共 RPC
            provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl);
            console.log('⚠ 未检测到钱包，使用只读模式');
        }

        // 4. 加载金库详情和用户信息
        await loadVaultDetails();
        await loadUserInfo();

        console.log('=== 初始化完成 ===');
    } catch (error) {
        console.error('初始化失败:', error);
        showModal('加载失败', '页面加载出错了，请刷新重试');
    }
}

async function loadABIs() {
    try {
        const [factoryRes, vaultRes] = await Promise.all([
            fetch('./abi/ConsensusVaultFactory.json'),
            fetch('./abi/ConsensusVault.json')
        ]);

        const [factoryData, vaultData] = await Promise.all([
            factoryRes.json(),
            vaultRes.json()
        ]);

        // 处理 ABI 格式：
        // 1. {abi: [...]} 格式
        // 2. {contractName: "...", abi: [...]} 格式
        // 3. [...] 直接数组格式
        VAULT_FACTORY_ABI = factoryData.abi || factoryData;
        CONSENSUS_VAULT_ABI = vaultData.abi || vaultData;

        // 确保都是数组
        if (!Array.isArray(VAULT_FACTORY_ABI)) {
            console.error('VAULT_FACTORY_ABI 不是数组:', typeof VAULT_FACTORY_ABI);
        }
        if (!Array.isArray(CONSENSUS_VAULT_ABI)) {
            console.error('CONSENSUS_VAULT_ABI 不是数组:', typeof CONSENSUS_VAULT_ABI);
        }

        console.log('✓ ABI 加载成功');
    } catch (error) {
        console.error('加载 ABI 失败:', error);
        throw error;
    }
}

async function connectWallet() {
    console.log('=== 开始连接钱包 ===');
    console.log('当前域名:', window.location.origin);
    console.log('当前协议:', window.location.protocol);

    const walletProvider = getWalletProvider();
    if (!walletProvider) {
        showModal('没有找到钱包', '请先安装 MetaMask 或 OKX 钱包插件');
        return;
    }

    try {
        showLoading('正在连接钱包...');

        const accounts = await walletProvider.request({
            method: 'eth_requestAccounts'
        });

        if (!accounts || accounts.length === 0) {
            throw new Error('未获取到账户');
        }

        walletAddress = accounts[0];
        console.log('✓ 钱包已连接:', walletAddress);

        // 检查并切换到正确的网络
        try {
            await walletProvider.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: CONFIG.chainId }],
            });
        } catch (switchError) {
            // 如果网络不存在，添加网络
            if (switchError.code === 4902) {
                try {
                    await walletProvider.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: CONFIG.chainId,
                            chainName: 'BSC Testnet',
                            nativeCurrency: {
                                name: 'BNB',
                                symbol: 'BNB',
                                decimals: 18
                            },
                            rpcUrls: [CONFIG.rpcUrl],
                            blockExplorerUrls: [CONFIG.explorer]
                        }],
                    });
                } catch (addError) {
                    console.error('添加网络失败:', addError);
                    throw new Error('添加网络失败: ' + addError.message);
                }
            } else if (switchError.code !== 4001) {
                // 4001 是用户取消，不抛出
                console.error('切换网络失败:', switchError);
                throw switchError;
            }
        }

        // 网络切换后，重新初始化 provider 和 signer
        provider = new ethers.providers.Web3Provider(walletProvider, 'any');
        signer = provider.getSigner();

        const network = await provider.getNetwork();
        currentNetwork = network.chainId === 56 ? 'mainnet' : 'testnet';

        updateUI();
        await loadUserInfo();

        hideLoading();
        showModal('连接成功', `已连接到 ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`);
    } catch (error) {
        console.error('连接钱包失败:', error);
        console.error('错误详情:', {
            message: error.message,
            code: error.code,
            stack: error.stack
        });
        hideLoading();

        let errorMsg = '钱包连接失败';
        if (error.message) {
            if (error.message.includes('user rejected') || error.message.includes('User denied')) {
                errorMsg = '您取消了连接请求';
            } else if (error.message.includes('Please unlock')) {
                errorMsg = '请先解锁您的钱包';
            } else {
                errorMsg = `连接失败: ${error.message}`;
            }
        }

        showModal('连接失败', errorMsg);
    }
}

async function loadVaultDetails() {
    try {
        if (!provider) {
            console.warn('无法加载金库详情：未检测到 provider');
            return;
        }

        const vault = new ethers.Contract(
            vaultAddress,
            CONSENSUS_VAULT_ABI,
            provider
        );

        const totalPrincipal = await vault.totalPrincipal();
        const totalVoteWeight = await vault.totalVoteWeight();
        const consensusReached = await vault.consensusReached();
        const unlockAt = await vault.unlockAt();
        const participantCount = await vault.participantCount();

        // 【状态监控】显示金库解锁状态
        console.log(`[状态监控] 当前金库解锁状态: ${consensusReached ? "🔓 已解锁" : "🔒 已锁定"}`);

        // 读取金库名称和代币符号并更新页面标题
        let depositTokenAddr = '';
        let vaultName = '';
        let tokenSymbol = 'TOKEN';
        try {
            depositTokenAddr = await vault.depositToken();

            // 读取自定义金库名称
            try {
                vaultName = await vault.name();
            } catch (e) {
                console.warn('读取金库名称失败:', e);
            }

            // 读取代币符号和小数位数
            try {
                const erc20 = new ethers.Contract(
                    depositTokenAddr,
                    ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
                    provider
                );
                tokenSymbol = await erc20.symbol();
            } catch (e) {
                console.warn('读取代币信息失败:', e);
                tokenSymbol = 'TOKEN';
            }

            // 格式化显示名称：金库名字 + 代币symbol
            const displayName = vaultName && vaultName.trim()
                ? `${vaultName} ${tokenSymbol}`
                : tokenSymbol;

            const titleEl = document.getElementById('vaultTitle');
            if (titleEl) {
                const iconHTML = '<i class="fas fa-vault"></i>';
                titleEl.innerHTML = `${iconHTML} ${displayName} 金库详情`;
            }
        } catch (e) {
            console.warn('读取金库信息失败，保留默认标题', e);
        }

        // 获取代币小数位数（如果 depositTokenAddr 为空，使用默认值18）
        const decimals = depositTokenAddr ? await getTokenDecimals(depositTokenAddr, provider) : 18;

        const totalPrincipalNum = parseFloat(formatTokenAmount(totalPrincipal, decimals));
        const totalVoteWeightNum = parseFloat(formatTokenAmount(totalVoteWeight, decimals));

        // 如果金库已解锁，进度显示 100%
        const progressPercent = consensusReached
            ? 100
            : (totalPrincipalNum > 0 ? (totalVoteWeightNum / totalPrincipalNum * 100) : 0);

        const nowSec = Math.floor(Date.now() / 1000);
        const unlockAtNum = parseInt(unlockAt.toString());

        // 更新 UI - 确保所有元素都存在
        const elem = (id) => document.getElementById(id);

        // 显示代币地址（在elem函数定义之后）
        if (depositTokenAddr && elem('tokenAddress')) {
            elem('tokenAddress').textContent = depositTokenAddr;
        }
        if (elem('totalDeposits')) elem('totalDeposits').textContent = formatPrecise(totalPrincipalNum);
        if (elem('yesVotes')) elem('yesVotes').textContent = formatPrecise(totalVoteWeightNum);
        if (elem('participantCount')) elem('participantCount').textContent = participantCount.toString();
        if (elem('progressPercent')) elem('progressPercent').textContent = progressPercent.toFixed(1) + '%';
        if (elem('progressFill')) elem('progressFill').style.width = Math.min(progressPercent, 100) + '%';

        const statusEl = elem('vaultStatus');
        if (statusEl) {
            statusEl.textContent = consensusReached ? '已解锁' : '锁定中';
            statusEl.className = consensusReached
                ? 'status-badge status-unlocked'
                : 'status-badge status-active';
        }

        // 解锁时间显示
        if (elem('unlockTime')) {
            if (!consensusReached) {
                elem('unlockTime').textContent = '未达成共识';
            } else if (nowSec >= unlockAtNum) {
                elem('unlockTime').textContent = `已解锁 (${formatTimestamp(unlockAtNum)})`;
            } else {
                const remainingSec = Math.max(unlockAtNum - nowSec, 0);
                const remainingHours = Math.ceil(remainingSec / 3600);
                elem('unlockTime').textContent = `${formatTimestamp(unlockAtNum)} (约 ${remainingHours} 小时后可提现)`;
            }
        }

        // 禁用/启用按钮根据状态
        if (elem('depositBtn')) elem('depositBtn').disabled = consensusReached;
        if (elem('voteBtn')) elem('voteBtn').disabled = consensusReached;
        if (elem('donateBtn')) elem('donateBtn').disabled = consensusReached;
        if (elem('withdrawBtn')) {
            elem('withdrawBtn').disabled = !consensusReached || (unlockAtNum > 0 && nowSec < unlockAtNum);
        }

        // 获取累计捐赠总额（从合约状态读取，而不是查询事件以避免 RPC 限制）
        try {
            console.log('开始读取累计捐赠...');
            const totalDonationsBN = await vault.totalDonations();
            const totalDonationsNum = parseFloat(formatTokenAmount(totalDonationsBN, decimals));
            console.log('累计捐赠总额:', totalDonationsNum);
            if (elem('totalDonations')) {
                elem('totalDonations').textContent = formatPrecise(totalDonationsNum);
                console.log('已更新 totalDonations 元素');
            }
        } catch (e) {
            console.warn('读取累计捐赠失败：', e?.message || e);
            // 降级方案：如果读取失败，设置为 0
            if (elem('totalDonations')) elem('totalDonations').textContent = '0';
        }

        // 获取价格并计算总市值
        if (depositTokenAddr) {
            if (elem('totalMarketValue')) {
                // 先显示加载中
                elem('totalMarketValue').textContent = '加载中...';
            }
            getTokenPrice(depositTokenAddr).then(priceData => {
                if (elem('totalMarketValue')) {
                    if (priceData) {
                        const totalValue = calculateTotalValue(totalPrincipalNum, priceData.price);
                        elem('totalMarketValue').textContent = totalValue;
                    } else {
                        elem('totalMarketValue').textContent = 'N/A';
                    }
                }
            }).catch(err => {
                console.warn('获取价格失败:', err);
                if (elem('totalMarketValue')) {
                    elem('totalMarketValue').textContent = 'N/A';
                }
            });
        } else {
            if (elem('totalMarketValue')) {
                elem('totalMarketValue').textContent = 'N/A';
            }
        }

        console.log('✓ 金库详情加载完成');
    } catch (error) {
        console.error('加载金库详情失败:', error);
    }
}

async function loadUserInfo() {
    console.log('[loadUserInfo] 开始加载用户信息, walletAddress:', walletAddress, 'provider:', provider ? '已初始化' : '未初始化');

    if (!walletAddress || !provider) {
        // 钱包未连接时显示 0
        console.log('[loadUserInfo] 钱包未连接或provider未初始化，显示默认值');
        if (document.getElementById('myDeposit')) {
            document.getElementById('myDeposit').textContent = '我的存款: 0.0000';
        }
        if (document.getElementById('myVotes')) {
            document.getElementById('myVotes').textContent = '我的投票权: 0.0000';
        }
        return;
    }

    try {
        console.log('[loadUserInfo] 初始化合约, vaultAddress:', vaultAddress);
        const vault = new ethers.Contract(
            vaultAddress,
            CONSENSUS_VAULT_ABI,
            provider
        );

        // 获取用户信息 (principal, rewardDebt, hasVoted)
        console.log('[loadUserInfo] 查询用户信息...');
        const userInfo = await vault.userInfo(walletAddress);
        console.log('[loadUserInfo] userInfo 原始数据:', userInfo);

        // 获取代币地址和小数位数
        const depositTokenAddr = await vault.depositToken();
        const decimals = await getTokenDecimals(depositTokenAddr, provider);

        const principal = userInfo.principal ? userInfo.principal : ethers.BigNumber.from(0);
        const principalNum = parseFloat(formatTokenAmount(principal, decimals));
        console.log('[loadUserInfo] 用户本金:', principalNum);

        const rewardDebt = userInfo.rewardDebt ? userInfo.rewardDebt : ethers.BigNumber.from(0);
        console.log('[loadUserInfo] rewardDebt:', rewardDebt.toString());

        const hasVoted = userInfo.hasVoted || false;
        console.log('[loadUserInfo] 是否已投票:', hasVoted);

        // 获取累积分红比例
        const accRewardPerShare = await vault.accRewardPerShare();
        console.log('[loadUserInfo] accRewardPerShare:', accRewardPerShare.toString());

        // 计算待分红：(本金 × 累积分红系数) - 分红债务
        const PRECISION = ethers.BigNumber.from('1000000000000'); // 1e12
        const pendingRewardRaw = principal.mul(accRewardPerShare).div(PRECISION).sub(rewardDebt);
        const pendingReward = parseFloat(formatTokenAmount(pendingRewardRaw, decimals));
        console.log('[loadUserInfo] ✅ 用户信息解析完成:', {
            principal: principalNum,
            hasVoted,
            pendingReward,
            rewardDebt: rewardDebt.toString()
        });

        // 显示本金
        if (document.getElementById('myDeposit')) {
            const depositText = `我的存款: ${formatPrecise(principalNum)}`;
            document.getElementById('myDeposit').textContent = depositText;
            console.log('[loadUserInfo] 存款信息已更新:', depositText);
        } else {
            console.warn('[loadUserInfo] 找不到 myDeposit 元素');
        }

        // 获取价格并计算用户持仓市值
        if (depositTokenAddr && principalNum > 0) {
            getTokenPrice(depositTokenAddr).then(priceData => {
                const myDepositValueEl = document.getElementById('myDepositValue');
                if (myDepositValueEl && priceData) {
                    const userValue = calculateTotalValue(principalNum, priceData.price);
                    myDepositValueEl.textContent = `我的持仓市值: ${userValue}`;
                    myDepositValueEl.style.display = 'block';
                } else if (myDepositValueEl) {
                    myDepositValueEl.style.display = 'none';
                }
            }).catch(err => {
                console.warn('获取用户持仓市值失败:', err);
            });
        } else {
            const myDepositValueEl = document.getElementById('myDepositValue');
            if (myDepositValueEl) {
                myDepositValueEl.style.display = 'none';
            }
        }

        // 显示投票状态
        if (document.getElementById('myVotes')) {
            const voteStatus = hasVoted ? '已投票' : `投票权: ${formatPrecise(principalNum)}`;
            document.getElementById('myVotes').textContent = voteStatus;
            console.log('[loadUserInfo] 投票状态已更新:', voteStatus);
        } else {
            console.warn('[loadUserInfo] 找不到 myVotes 元素');
        }

        // 显示待分红
        if (document.getElementById('myReward')) {
            document.getElementById('myReward').textContent = `我获得的捐赠收益: ${formatPrecise(pendingReward)}`;
            console.log('[loadUserInfo] 收益信息已更新:', formatPrecise(pendingReward));
        } else {
            console.warn('[loadUserInfo] 找不到 myReward 元素');
        }

    } catch (error) {
        console.error('[loadUserInfo] ❌ 加载用户信息失败:', error);
        console.error('[loadUserInfo] 错误详情:', error.message);
        console.error('[loadUserInfo] 错误堆栈:', error.stack);
        // 显示默认值
        if (document.getElementById('myDeposit')) {
            document.getElementById('myDeposit').textContent = '我的存款: 0.0000';
        }
        if (document.getElementById('myVotes')) {
            document.getElementById('myVotes').textContent = '我的投票权: 0.0000';
        }
        if (document.getElementById('myReward')) {
            document.getElementById('myReward').textContent = '我的收益: 0.0000';
        }
    }

    // 刷新市场信息
    await updateMarketUserInfo();
}

async function loadVaultEvents() {
    try {
        if (!provider) {
            console.log('⚠ Provider 未初始化，跳过事件加载');
            const tbody = document.getElementById('vaultEventBody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">暂无事件</td></tr>';
            return;
        }

        const vault = new ethers.Contract(vaultAddress, CONSENSUS_VAULT_ABI, provider);

        // 并行查询各类事件
        console.log('开始查询事件...');
        const [depositedEvents, votedEvents, donatedEvents, consensusEvents, withdrawnEvents] = await Promise.all([
            vault.queryFilter('Deposited', 0, 'latest').catch((e) => { console.error('查询 Deposited 失败:', e); return []; }),
            vault.queryFilter('Voted', 0, 'latest').catch((e) => { console.error('查询 Voted 失败:', e); return []; }),
            vault.queryFilter('Donated', 0, 'latest').catch((e) => { console.error('查询 Donated 失败:', e); return []; }),
            vault.queryFilter('ConsensusAchieved', 0, 'latest').catch((e) => { console.error('查询 ConsensusAchieved 失败:', e); return []; }),
            vault.queryFilter('Withdrawn', 0, 'latest').catch((e) => { console.error('查询 Withdrawn 失败:', e); return []; })
        ]);

        console.log('事件查询结果:', {
            depositedEvents: depositedEvents.length,
            votedEvents: votedEvents.length,
            donatedEvents: donatedEvents.length,
            consensusEvents: consensusEvents.length,
            withdrawnEvents: withdrawnEvents.length
        });

        const events = [];

        // 获取代币地址和小数位数
        const depositTokenAddr = await vault.depositToken();
        const decimals = await getTokenDecimals(depositTokenAddr, provider);

        depositedEvents.forEach(e => {
            events.push({
                type: '存款',
                user: e.args.user,
                amount: formatTokenAmount(e.args.amount, decimals),
                blockNumber: e.blockNumber,
                txHash: e.transactionHash
            });
        });

        votedEvents.forEach(e => {
            events.push({
                type: '投票',
                user: e.args.user,
                amount: formatTokenAmount(e.args.amount, decimals),
                blockNumber: e.blockNumber,
                txHash: e.transactionHash
            });
        });

        donatedEvents.forEach(e => {
            events.push({
                type: '捐赠',
                user: e.args.donor,
                amount: formatTokenAmount(e.args.amount, decimals),
                blockNumber: e.blockNumber,
                txHash: e.transactionHash
            });
        });

        consensusEvents.forEach(e => {
            events.push({
                type: '解锁',
                blockNumber: e.blockNumber,
                txHash: e.transactionHash
            });
        });

        withdrawnEvents.forEach(e => {
            events.push({
                type: '提现',
                user: e.args.user,
                principal: formatTokenAmount(e.args.principal, decimals),
                reward: formatTokenAmount(e.args.reward, decimals),
                blockNumber: e.blockNumber,
                txHash: e.transactionHash
            });
        });

        // 按块号排序（最新在前）
        events.sort((a, b) => b.blockNumber - a.blockNumber);

        console.log('总事件数:', events.length);
        renderVaultEvents(events);
        console.log('✓ 事件加载完成，共', events.length, '条事件');
    } catch (error) {
        console.error('加载事件失败:', error);
        const tbody = document.getElementById('vaultEventBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">暂无事件</td></tr>';
        }
    }
}

function renderVaultEvents(events) {
    const tbody = document.getElementById('vaultEventBody');
    if (!tbody) return;

    if (events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">暂无事件</td></tr>';
        return;
    }

    let html = '';
    const explorerUrl = CONFIG.explorer;

    events.forEach(event => {
        let row = '<tr>';
        row += `<td>${event.type}</td>`;

        if (event.type === '解锁') {
            row += '<td>系统</td><td>—</td>';
        } else {
            row += `<td>${formatAddress(event.user)}</td>`;
            if (event.type === '提现') {
                row += `<td>本金: ${formatPrecise(parseFloat(event.principal))}, 收益: ${formatPrecise(parseFloat(event.reward))}</td>`;
            } else {
                row += `<td>${formatPrecise(parseFloat(event.amount))}</td>`;
            }
        }

        row += `<td>区块 ${event.blockNumber}</td>`;
        row += `<td><a href="${explorerUrl}/tx/${event.txHash}" target="_blank" class="link-small">查看</a></td>`;
        row += '</tr>';

        html += row;
    });

    tbody.innerHTML = html;
}

function formatAddress(addr) {
    if (!addr || addr === '—') return '—';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function setupEventListeners() {
    // 连接钱包按钮
    const connectBtn = document.getElementById('connectButton');
    if (connectBtn) {
        connectBtn.addEventListener('click', () => {
            if (walletAddress) {
                walletAddress = null;
                signer = null;
                updateUI();
                showModal('已断开', '钱包已断开连接');
            } else {
                connectWallet();
            }
        });
    }

    // 返回按钮（修复）
    const backBtn = document.querySelector('button[onclick="goBack()"]') ||
        document.querySelector('.btn.ghost') ||
        document.querySelector('button.back-btn');
    if (backBtn) {
        backBtn.addEventListener('click', (e) => {
            e.preventDefault();
            goBack();
        });
    }

    // 存款按钮
    const depositBtn = document.getElementById('depositBtn');
    if (depositBtn) {
        depositBtn.addEventListener('click', async () => {
            if (!walletAddress) {
                showModal('还没连接钱包', '请先点击右上角连接您的钱包');
                return;
            }
            const amount = document.getElementById('depositAmount')?.value?.trim();
            if (!amount || parseFloat(amount) <= 0) {
                showModal('金额不对', '请输入有效的金额');
                return;
            }
            await deposit(amount);
        });
    }

    // 投票按钮
    const voteBtn = document.getElementById('voteBtn');
    if (voteBtn) {
        voteBtn.addEventListener('click', async () => {
            if (!walletAddress) {
                showModal('还没连接钱包', '请先点击右上角连接您的钱包');
                return;
            }
            await vote();
        });
    }

    // 提现按钮
    const withdrawBtn = document.getElementById('withdrawBtn');
    if (withdrawBtn) {
        withdrawBtn.addEventListener('click', async () => {
            if (!walletAddress) {
                showModal('还没连接钱包', '请先点击右上角连接您的钱包');
                return;
            }
            await withdraw();
        });
    }

    // 捐赠按钮
    const donateBtn = document.getElementById('donateBtn');
    if (donateBtn) {
        donateBtn.addEventListener('click', async () => {
            if (!walletAddress) {
                showModal('还没连接钱包', '请先点击右上角连接您的钱包');
                return;
            }
            const amount = document.getElementById('donateAmount')?.value?.trim();
            if (!amount || parseFloat(amount) <= 0) {
                showModal('金额不对', '请输入有效的金额');
                return;
            }
            await donate(amount);
        });
    }

    // ===== 二级市场交易 =====
    // 转移功能已移除 - 用户可在钱包或DEX(PancakeSwap等)中转移VToken

    // 更新用户市场信息
    if (walletAddress) {
        updateMarketUserInfo();
    }

    // 模态框关闭
    const modalClose = document.querySelector('.modal-close');
    if (modalClose) {
        modalClose.addEventListener('click', () => {
            const overlay = document.getElementById('modalOverlay');
            if (overlay) overlay.style.display = 'none';
        });
    }

    // 钱包事件监听
    const walletProvider = getWalletProvider();
    if (walletProvider) {
        // 移除旧的事件监听器（如果存在）
        if (walletProvider.removeAllListeners) {
            walletProvider.removeAllListeners('accountsChanged');
            walletProvider.removeAllListeners('chainChanged');
        }

        walletProvider.on('accountsChanged', (accounts) => {
            console.log('账户已切换:', accounts);
            if (accounts.length === 0) {
                walletAddress = null;
                signer = null;
                updateUI();
            } else if (accounts[0] !== walletAddress) {
                // 仅更新账户并刷新用户信息（不弹“连接成功”提示）
                walletAddress = accounts[0];
                signer = provider ? provider.getSigner() : null;
                updateUI();
                loadUserInfo();
            }
        });

        walletProvider.on('chainChanged', () => {
            console.log('网络已切换，重新加载页面');
            window.location.reload();
        });
    }
}

function updateUI() {
    const btn = document.getElementById('connectButton');
    if (!btn) return;

    if (walletAddress) {
        const short = walletAddress.slice(0, 6) + '...' + walletAddress.slice(-4);
        btn.innerHTML = `<i class="fas fa-wallet"></i> ${short}`;
        btn.classList.add('connected');
        btn.title = '点击断开连接';
    } else {
        btn.innerHTML = '<i class="fas fa-wallet"></i> 连接钱包';
        btn.classList.remove('connected');
        btn.title = '连接钱包';
    }
}

function showLoading(text = '处理中...') {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        document.getElementById('loadingText').textContent = text;
        overlay.style.display = 'flex';
    }
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
}

function showModal(title, message) {
    const overlay = document.getElementById('modalOverlay');
    if (!overlay) return;

    overlay.querySelector('.modal-title').textContent = title;
    overlay.querySelector('.modal-body').textContent = message;
    overlay.style.display = 'block';
}

function goBack() {
    console.log('返回主页');
    window.location.href = 'index.html';
}

// 安全等待交易确认（避免 ENS 错误）
async function safeWaitForTransaction(tx) {
    try {
        return await tx.wait();
    } catch (error) {
        if (error.message && error.message.includes('ENS')) {
            console.warn('检测到 ENS 错误，使用备用方法获取交易收据');
            let receipt = await provider.getTransactionReceipt(tx.hash);
            let attempts = 0;
            while ((!receipt || !receipt.blockNumber) && attempts < 30) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                receipt = await provider.getTransactionReceipt(tx.hash);
                attempts++;
            }
            if (!receipt || !receipt.blockNumber) {
                throw new Error('交易超时，请在区块浏览器中查看: ' + tx.hash);
            }
            return receipt;
        }
        throw error;
    }
}

// ===== 交易函数 =====
async function deposit(amount) {
    console.log('[deposit] 开始存款流程, 金额:', amount);
    try {
        if (!signer) {
            showModal('还没连接钱包', '请先连接钱包');
            return;
        }

        showLoading('检查账户状态...');

        const vault = new ethers.Contract(vaultAddress, CONSENSUS_VAULT_ABI, signer);

        // 检查金库是否已解锁
        console.log('[deposit] 检查金库状态...');
        const consensusReached = await vault.consensusReached();
        console.log('[deposit] 金库状态 - consensusReached:', consensusReached);
        if (consensusReached) {
            hideLoading();
            showModal('金库已解锁', '这个金库已经达成共识解锁了，不再接受新的存款。');
            return;
        }

        // 投票后不能再存款
        const userInfo = await vault.userInfo(walletAddress);
        if (userInfo.hasVoted) {
            hideLoading();
            showModal('已投票', '您已投票，不能再追加存款。如需继续参与，请使用其他地址。');
            return;
        }

        const depositTokenAddr = await vault.depositToken();
        console.log('✓ 存款代币地址:', depositTokenAddr);

        // 获取代币小数位数
        const tokenDecimals = await getTokenDecimals(depositTokenAddr, provider);

        const depositToken = new ethers.Contract(
            depositTokenAddr,
            ['function approve(address spender, uint256 amount) public returns (bool)', 'function balanceOf(address owner) public view returns (uint256)'],
            signer
        );

        // 检查余额
        const userBalance = await depositToken.balanceOf(walletAddress);
        const amountWei = parseTokenAmount(amount, tokenDecimals);
        console.log('✓ 钱包余额:', formatTokenAmount(userBalance, tokenDecimals));
        console.log('✓ 存款金额:', amount, '(', amountWei.toString(), 'wei)');

        if (userBalance.lt(amountWei)) {
            hideLoading();
            showModal('余额不足', `您的余额只有 ${formatTokenAmount(userBalance, tokenDecimals)}，不足以存款 ${amount}`);
            console.log('[deposit] 余额不足，终止流程');
            return;
        }

        // 授权
        showLoading('步骤1/3: 授权代币...');
        console.log('[deposit] 发送授权交易...');
        const approveTx = await depositToken.approve(vaultAddress, amountWei);
        console.log('✓ 授权交易已发送:', approveTx.hash);
        await safeWaitForTransaction(approveTx);
        console.log('✓ 授权成功');

        // 记录存款前的余额
        showLoading('步骤2/3: 记录余额状态...');
        const userBalanceBefore = await getTokenBalance(depositTokenAddr, walletAddress);
        const vaultBalanceBefore = await getTokenBalance(depositTokenAddr, vaultAddress);
        console.log('📊 存款前余额:');
        console.log(`   用户: ${formatTokenAmount(userBalanceBefore, tokenDecimals)}`);
        console.log(`   金库: ${formatTokenAmount(vaultBalanceBefore, tokenDecimals)}`);

        // 存款
        showLoading('步骤3/3: 存款中...');
        console.log('[deposit] 发送存款交易...');
        const depositTx = await vault.deposit(amountWei);
        console.log('✓ 存款交易已发送:', depositTx.hash);
        const depositReceipt = await safeWaitForTransaction(depositTx);
        console.log('✓ 存款成功');

        // 记录存款后的余额
        const userBalanceAfter = await getTokenBalance(depositTokenAddr, walletAddress);
        const vaultBalanceAfter = await getTokenBalance(depositTokenAddr, vaultAddress);

        // 验证链上转账
        const transferVerified = await verifyTokenTransfer(
            depositReceipt,
            depositTokenAddr,
            walletAddress,
            vaultAddress,
            amountWei,
            userBalanceBefore,
            userBalanceAfter
        );
        console.log('📊 存款后余额:');
        console.log(`   用户: ${formatTokenAmount(userBalanceAfter, tokenDecimals)}`);
        console.log(`   金库: ${formatTokenAmount(vaultBalanceAfter, tokenDecimals)}`);
        console.log(`   用户变化: ${formatTokenAmount(userBalanceBefore.sub(userBalanceAfter), tokenDecimals)}`);
        console.log(`   金库变化: ${formatTokenAmount(vaultBalanceAfter.sub(vaultBalanceBefore), tokenDecimals)}`);

        if (transferVerified) {
            console.log('✅ 存款交易已在链上确认');
        } else {
            console.warn('⚠️ 存款交易验证异常，请检查交易详情');
        }

        hideLoading();
        showModal('存款成功', `已成功存款 ${amount}\n\n欢迎参与投票来支持这个金库的共识。`);
        document.getElementById('depositAmount').value = '';

        // 刷新数据
        await loadVaultDetails();
        await loadUserInfo();
    } catch (error) {
        hideLoading();
        console.error('[deposit] ❌ 存款失败:', error);
        console.error('[deposit] 错误详情:', error.message);
        console.error('[deposit] 错误堆栈:', error.stack);

        let errorMsg = '存款交易失败了，请重试';
        if (error.message) {
            if (error.message.includes('user rejected') || error.message.includes('User denied')) {
                errorMsg = '您取消了交易';
            } else if (error.message.includes('insufficient funds')) {
                errorMsg = '余额不足，请检查您的钱包余额';
            } else if (error.message.includes('Transfer failed')) {
                errorMsg = '代币转移失败，请检查您是否授权了足够的金额';
            } else if (error.message.includes('Consensus reached')) {
                errorMsg = '金库已解锁，不再接受新的存款';
            } else if (error.message.includes('execution reverted')) {
                errorMsg = '合约拒绝了交易，请检查您的账户状态和余额';
            }
        }

        showModal('存款失败', errorMsg);
    }
}

async function vote() {
    try {
        if (!signer) {
            showModal('还没连接钱包', '请先连接钱包');
            return;
        }

        showLoading('检查投票权...');

        const vault = new ethers.Contract(vaultAddress, CONSENSUS_VAULT_ABI, signer);

        // 检查金库是否已解锁
        const consensusReached = await vault.consensusReached();
        if (consensusReached) {
            hideLoading();
            showModal('金库已解锁', '金库已达成共识解锁了，不再接受投票。\n\n您现在可以提现您的本金和收益。');
            return;
        }

        // 检查用户是否有本金（投票权来自存款）
        const depositTokenAddr = await vault.depositToken();
        const tokenDecimals = await getTokenDecimals(depositTokenAddr, provider);

        const userInfo = await vault.userInfo(walletAddress);
        const principal = userInfo.principal;
        const hasVoted = userInfo.hasVoted;
        console.log('✓ 用户本金:', formatTokenAmount(principal, tokenDecimals));
        console.log('✓ 是否已投票:', hasVoted);

        if (principal.isZero()) {
            hideLoading();
            showModal('无法投票', '您没有投票权。\n\n投票权来自您在金库中的存款。\n\n您需要先存款才能投票。');
            return;
        }

        if (hasVoted) {
            hideLoading();
            showModal('已投票', '您已经投过票了。\n\n每个用户只能投票一次。');
            return;
        }

        showLoading('执行投票中...');
        console.log('发送投票交易...');
        const voteTx = await vault.voteForConsensus();
        console.log('✓ 投票交易已发送:', voteTx.hash);
        await safeWaitForTransaction(voteTx);
        console.log('✓ 投票成功');

        hideLoading();
        showModal('投票成功', '已成功投票支持共识！\n\n如果共识达成，金库将解锁，您可以提现本金和收益。');

        // 刷新数据
        await loadVaultDetails();
        await loadUserInfo();
    } catch (error) {
        hideLoading();
        console.error('投票失败:', error);

        let errorMsg = '投票交易失败了，请重试';
        if (error.message) {
            if (error.message.includes('user rejected') || error.message.includes('User denied')) {
                errorMsg = '您取消了交易';
            } else if (error.message.includes('No principal')) {
                errorMsg = '您没有投票权，需要先存款';
            } else if (error.message.includes('Already voted')) {
                errorMsg = '您已经投过票了';
            } else if (error.message.includes('Consensus already reached')) {
                errorMsg = '金库已达成共识解锁，不再接受投票';
            } else if (error.message.includes('execution reverted')) {
                errorMsg = '合约拒绝了投票，可能是金库已解锁或您已投票';
            }
        }

        showModal('投票失败', errorMsg);
    }
}

async function withdraw() {
    try {
        if (!signer) {
            showModal('还没连接钱包', '请先连接钱包');
            return;
        }

        showLoading('检查用户信息...');

        const vault = new ethers.Contract(vaultAddress, CONSENSUS_VAULT_ABI, signer);

        // 获取代币地址和用户信息
        const depositTokenAddr = await vault.depositToken();
        const tokenDecimals = await getTokenDecimals(depositTokenAddr, provider);
        const userInfo = await vault.userInfo(walletAddress);

        // 手动计算 pendingReward
        const accRewardPerShare = await vault.accRewardPerShare();
        const PRECISION = ethers.BigNumber.from('1000000000000'); // 1e12
        const pendingReward = userInfo.principal.mul(accRewardPerShare).div(PRECISION).sub(userInfo.rewardDebt);
        const expectedAmount = userInfo.principal.add(pendingReward);

        console.log('提现信息:');
        console.log(`   本金: ${formatTokenAmount(userInfo.principal, tokenDecimals)}`);
        console.log(`   收益: ${formatTokenAmount(pendingReward, tokenDecimals)}`);
        console.log(`   总计: ${formatTokenAmount(expectedAmount, tokenDecimals)}`);

        // 记录提现前的余额
        showLoading('记录余额状态...');
        const userBalanceBefore = await getTokenBalance(depositTokenAddr, walletAddress);
        const vaultBalanceBefore = await getTokenBalance(depositTokenAddr, vaultAddress);
        console.log('📊 提现前余额:');
        console.log(`   用户: ${formatTokenAmount(userBalanceBefore, tokenDecimals)}`);
        console.log(`   金库: ${formatTokenAmount(vaultBalanceBefore, tokenDecimals)}`);

        showLoading('执行提现中...');
        console.log('发送提现交易...');
        const withdrawTx = await vault.withdrawAll();
        console.log('✓ 提现交易已发送:', withdrawTx.hash);
        const withdrawReceipt = await safeWaitForTransaction(withdrawTx);
        console.log('✓ 提现成功');

        // 记录提现后的余额
        const userBalanceAfter = await getTokenBalance(depositTokenAddr, walletAddress);
        const vaultBalanceAfter = await getTokenBalance(depositTokenAddr, vaultAddress);

        // 验证链上转账
        const transferVerified = await verifyTokenTransfer(
            withdrawReceipt,
            depositTokenAddr,
            vaultAddress,
            walletAddress,
            expectedAmount,
            vaultBalanceBefore,
            vaultBalanceAfter
        );
        console.log('📊 提现后余额:');
        console.log(`   用户: ${formatTokenAmount(userBalanceAfter, tokenDecimals)}`);
        console.log(`   金库: ${formatTokenAmount(vaultBalanceAfter, tokenDecimals)}`);
        console.log(`   用户变化: +${formatTokenAmount(userBalanceAfter.sub(userBalanceBefore), tokenDecimals)}`);
        console.log(`   金库变化: -${formatTokenAmount(vaultBalanceBefore.sub(vaultBalanceAfter), tokenDecimals)}`);

        if (transferVerified) {
            console.log('✅ 提现交易已在链上确认');
        } else {
            console.warn('⚠️ 提现交易验证异常，请检查交易详情');
        }

        hideLoading();
        showModal('提现成功', '已成功提现全部本金和收益');

        // 【Dust监控】提现后检查
        try {
            const depositTokenAddr = await vault.depositToken();
            const tokenDecimals = await getTokenDecimals(depositTokenAddr, provider);

            const totalDonationsBN = await vault.totalDonations();
            const totalDonationsNum = parseFloat(formatTokenAmount(totalDonationsBN, tokenDecimals));
            const totalPrincipalBN = await vault.totalPrincipal();
            const totalPrincipalNum = parseFloat(formatTokenAmount(totalPrincipalBN, tokenDecimals));

            const depositToken = new ethers.Contract(
                depositTokenAddr,
                ['function balanceOf(address) view returns (uint256)'],
                provider
            );
            const contractBalanceBN = await depositToken.balanceOf(vaultAddress);
            const contractBalanceNum = parseFloat(formatTokenAmount(contractBalanceBN, tokenDecimals));

            // ✅ 一致性检查（Atomic Settlement Vault）
            // 本 Vault 为一次性清算模型：Donation → accRewardPerShare → 解锁后用户一次性提走
            // 因此系统设计上不存在 Dust 概念，只需检查清算完毕后是否有异常余额
            const minBalanceThreshold = parseTokenAmount('0.001', tokenDecimals);

            if (totalPrincipalNum === 0 && contractBalanceBN.gt(minBalanceThreshold)) {
                console.warn(
                    '[一致性检查] ⚠️ 所有用户已清算，但合约仍有异常余额:',
                    formatPrecise(contractBalanceNum),
                    'wei'
                );
            } else {
                console.log('[一致性检查] ✓ 清算状态正常 - totalPrincipal:', totalPrincipalNum, '合约余额:', contractBalanceNum);
            }
        } catch (e) {
            console.warn('[一致性检查] 异常:', e?.message);
        }

        // 刷新数据
        await loadVaultDetails();
        await loadUserInfo();
    } catch (error) {
        hideLoading();
        console.error('提现失败:', error);

        let errorMsg = '提现交易失败了，请重试';
        if (error.message) {
            if (error.message.includes('user rejected') || error.message.includes('User denied')) {
                errorMsg = '您取消了交易';
            } else if (error.message.includes('Not unlocked')) {
                errorMsg = '金库还没解锁，需要达成共识后才能提现本金和捐赠收益';
            } else if (error.message.includes('Unlock time not reached')) {
                errorMsg = '共识已达成，但尚未到解锁时间，请稍后再试';
            } else if (error.message.includes('execution reverted')) {
                errorMsg = '合约拒绝了提现，请确认金库已解锁且您有存款';
            }
        }

        showModal('提现失败', errorMsg);
    }
}

async function donate(amount) {
    try {
        if (!signer) {
            showModal('还没连接钱包', '请先连接钱包');
            return;
        }

        showLoading('检查金库状态...');

        const vault = new ethers.Contract(vaultAddress, CONSENSUS_VAULT_ABI, signer);

        // 检查金库是否已解锁
        const consensusReached = await vault.consensusReached();
        if (consensusReached) {
            hideLoading();
            showModal('金库已解锁', '这个金库已经达成共识解锁了，不再接受捐赠。');
            return;
        }

        const depositTokenAddr = await vault.depositToken();
        console.log('✓ 捐赠代币地址:', depositTokenAddr);

        // 获取代币小数位数
        const tokenDecimals = await getTokenDecimals(depositTokenAddr, provider);

        const depositToken = new ethers.Contract(
            depositTokenAddr,
            ['function approve(address spender, uint256 amount) public returns (bool)', 'function balanceOf(address owner) public view returns (uint256)'],
            signer
        );

        const amountWei = parseTokenAmount(amount, tokenDecimals);
        console.log('✓ 捐赠金额:', amount, '(', amountWei.toString(), 'wei)');

        // 在授权前先检查余额
        showLoading('检查账户余额...');
        const userBalance = await depositToken.balanceOf(walletAddress);
        console.log('✓ 钱包余额:', formatTokenAmount(userBalance, tokenDecimals));

        if (userBalance.lt(amountWei)) {
            hideLoading();
            showModal('余额不足', `您的余额只有 ${formatTokenAmount(userBalance, tokenDecimals)}，不足以捐赠 ${amount}`);
            console.log('[donate] 余额不足，终止流程');
            return;
        }

        // 余额足够，开始授权
        showLoading('步骤1/2: 授权代币...');
        console.log('发送授权交易...');
        const approveTx = await depositToken.approve(vaultAddress, amountWei);
        console.log('✓ 授权交易已发送:', approveTx.hash);
        await safeWaitForTransaction(approveTx);
        console.log('✓ 授权成功');

        // 捐赠
        showLoading('步骤2/2: 捐赠中...');
        console.log('发送捐赠交易...');
        const donateTx = await vault.donate(amountWei);
        console.log('✓ 捐赠交易已发送:', donateTx.hash);
        await safeWaitForTransaction(donateTx);
        console.log('✓ 捐赠成功');

        hideLoading();
        showModal('捐赠成功', `已成功捐赠 ${amount}，感谢您的支持！`);
        document.getElementById('donateAmount').value = '';

        // 刷新数据（包括用户分红信息）
        await loadVaultDetails();
        await loadUserInfo();
    } catch (error) {
        hideLoading();
        console.error('捐赠失败:', error);

        let errorMsg = '捐赠交易失败了，请重试';
        if (error.message) {
            if (error.message.includes('user rejected') || error.message.includes('User denied')) {
                errorMsg = '您取消了交易';
            } else if (error.message.includes('insufficient funds')) {
                errorMsg = '余额不足，请检查您的钱包余额';
            } else if (error.message.includes('Consensus reached, donation closed')) {
                errorMsg = '金库已解锁，不再接受捐赠';
            } else if (error.message.includes('Amount must be > 0')) {
                errorMsg = '捐赠金额必须大于0';
            } else if (error.message.includes('Transfer failed')) {
                errorMsg = '代币转移失败，请检查您的余额和授权';
            } else if (error.message.includes('execution reverted')) {
                errorMsg = '合约拒绝了捐赠，请检查：\n1. 金库是否已解锁\n2. 代币余额是否充足\n3. 是否已授权足够的额度';
            }
        }

        showModal('捐赠失败', errorMsg);
    }
}

// ===== 调试工具函数 =====
/**
 * 诊断钱包连接问题
 */
function diagnoseWalletConnection() {
    console.log('=== 钱包连接诊断 ===');
    console.log('当前域名:', window.location.origin);
    console.log('当前协议:', window.location.protocol);
    console.log('是否HTTPS:', window.location.protocol === 'https:');

    const walletProvider = getWalletProvider();
    if (walletProvider) {
        console.log('✓ 检测到钱包提供者');
        console.log('提供者类型:', {
            isOKX: walletProvider.isOKX || walletProvider.isOkxWallet,
            isMetaMask: walletProvider.isMetaMask,
            hasRequest: typeof walletProvider.request === 'function',
            hasOn: typeof walletProvider.on === 'function'
        });
    } else {
        console.error('✗ 未检测到钱包提供者');
        console.log('可用的窗口对象:', {
            ethereum: typeof window.ethereum !== 'undefined',
            okxwallet: typeof window.okxwallet !== 'undefined',
            okexchain: typeof window.okexchain !== 'undefined'
        });
    }
}

// ===== 页面加载 =====
window.addEventListener('load', () => {
    console.log('金库详情页加载...');
    // 执行诊断
    diagnoseWalletConnection();
    init();
});

/**
 * ===== 二级市场功能 =====
 * 支持 VToken 的二级市场交易
 */

/**
 * 查询用户是否为原始存款者
 * 原始存款者可以提现本金和分红
 */
/**
 * 获取用户的本金和投票信息
 */
async function getUserPrincipalAndVotes(userAddress) {
    try {
        if (!provider) {
            console.warn('Provider 未初始化');
            return { principal: '0', hasVoted: false };
        }

        const vault = new ethers.Contract(
            vaultAddress,
            CONSENSUS_VAULT_ABI,
            provider
        );

        const depositTokenAddr = await vault.depositToken();
        const tokenDecimals = await getTokenDecimals(depositTokenAddr, provider);

        const userInfo = await vault.userInfo(userAddress);
        const principal = formatTokenAmount(userInfo.principal || ethers.BigNumber.from(0), tokenDecimals);
        const hasVoted = userInfo.hasVoted || false;

        return { principal, hasVoted };
    } catch (error) {
        console.error('获取用户信息失败:', error);
        return { principal: '0', hasVoted: false };
    }
}

/**
 * 更新用户的市场相关信息显示
 */
async function updateMarketUserInfo() {
    if (!walletAddress) {
        return;
    }

    try {
        const info = await getUserPrincipalAndVotes(walletAddress);

        // 更新投票权显示
        const voteElem = document.getElementById('userVoteBalance');
        if (voteElem) {
            const voteStatus = info.hasVoted ? '已投票' : `投票权: ${info.principal}`;
            voteElem.textContent = voteStatus;
        }

        // 更新本金显示
        const principalElem = document.getElementById('userPrincipal');
        if (principalElem) {
            principalElem.textContent = `本金: ${formatPrecise(parseFloat(info.principal))}`;
        }
    } catch (error) {
        console.error('更新市场用户信息失败:', error);
    }
}

/**
 * 转移功能已移除
 * 用户可在以下地方转移Token：
 * 1. MetaMask钱包直接转账
 * 2. 在PancakeSwap/Uniswap等DEX上交易
 */

// ===== 导出全局函数 =====
window.goBack = goBack;
window.connectWallet = connectWallet;
window.deposit = deposit;
window.vote = vote;
window.withdraw = withdraw;
window.donate = donate;
