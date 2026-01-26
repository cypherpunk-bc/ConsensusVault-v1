// ============================================
// ConsensusVault 金库详情页 - vault.js
// ============================================

// ===== 配置 =====
// 网络配置对象
const NETWORKS = {
    mainnet: {
        chainId: '0x38',
        chainIdDec: 56,
        chainName: 'BNB Smart Chain',
        displayName: 'BSC 主网',
        rpcUrl: 'https://bsc-dataseed.bnbchain.org',
        explorer: 'https://bscscan.com',
        factoryAddress: '0x2aBFa239b09A1D4B03c8F65Ef59e855D6bBf75Ab',
        commentVaultAddress: '0xB5C08A89F11D18A62361b87Dc963379281CA6D82'

    },
    testnet: {
        chainId: '0x61',
        chainIdDec: 97,
        chainName: 'BSC Testnet',
        displayName: 'BSC 测试网',
        rpcUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545',
        explorer: 'https://testnet.bscscan.com',
        factoryAddress: '0xc9FA3e06A09a5b6257546C6eB8De2868275A2f98', // 测试网工厂合约地址
        commentVaultAddress: '0xEE608F2E0C15EDae26D3D19113d4661353140b76' // 测试网留言合约地址
    }
};

// 当前网络（从 localStorage 读取，默认主网）
let currentNetwork = localStorage.getItem('selectedNetwork') || 'mainnet';
if (!NETWORKS[currentNetwork]) {
    currentNetwork = 'mainnet';
}

// 当前配置（动态）
let CONFIG = { ...NETWORKS[currentNetwork] };

// 工厂合约地址（根据当前网络动态获取）
let VAULT_FACTORY_ADDRESS = CONFIG.factoryAddress;

// ===== 全局状态 =====
let provider, signer, walletAddress;
let vaultAddress = null;
let isNetworkSwitching = false; // 网络切换标志，防止重复切换
let VAULT_FACTORY_ABI = [];
let CONSENSUS_VAULT_ABI = [];
let COMMENT_VAULT_ABI = [];

// 金库状态（用于按钮禁用检查）
let vaultState = {
    consensusReached: false,
    unlockAt: 0,
    canWithdraw: false
};

/** 操作成功后的待留言上下文，用于关联留言与操作 */
let pendingCommentContext = null;

/** 金库分享用元数据（在 loadVaultDetails 中更新） */
let vaultShareMeta = { displayName: '', totalDeposits: '', participantCount: 0, consensusReached: false, tokenSymbol: '' };

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

// ===== 留言功能（链上存储） =====

/**
 * 获取 CommentVault 合约实例
 * @returns {ethers.Contract|null}
 */
function getCommentVaultContract() {
    if (!provider || !CONFIG.commentVaultAddress) {
        console.warn('[留言] CommentVault 合约地址未配置');
        return null;
    }
    if (COMMENT_VAULT_ABI.length === 0) {
        console.warn('[留言] CommentVault ABI 未加载');
        return null;
    }
    return new ethers.Contract(CONFIG.commentVaultAddress, COMMENT_VAULT_ABI, provider);
}

/**
 * 获取 CommentVault 合约实例（用于写操作）
 * @returns {ethers.Contract|null}
 */
function getCommentVaultContractWithSigner() {
    if (!signer || !CONFIG.commentVaultAddress) {
        console.warn('[留言] CommentVault 合约地址未配置或未连接钱包');
        return null;
    }
    if (COMMENT_VAULT_ABI.length === 0) {
        console.warn('[留言] CommentVault ABI 未加载');
        return null;
    }
    return new ethers.Contract(CONFIG.commentVaultAddress, COMMENT_VAULT_ABI, signer);
}

/**
 * 将字符串转换为 bytes32（用于 action 和 txHash）
 * @param {string} str
 * @returns {string} bytes32 hex string
 */
function stringToBytes32(str) {
    if (!str || str === '') return ethers.constants.HashZero;
    try {
        // 如果是交易哈希（0x开头，66字符），直接转换为 bytes32
        if (str.startsWith('0x') && str.length === 66) {
            return ethers.utils.hexZeroPad(str, 32);
        }
        // 如果是短字符串（action），格式化为 bytes32（最多31字符）
        if (str.length <= 31) {
            return ethers.utils.formatBytes32String(str);
        }
        // 如果字符串太长，截断并转换
        return ethers.utils.formatBytes32String(str.slice(0, 31));
    } catch (e) {
        console.warn('[留言] 转换 bytes32 失败:', e);
        return ethers.constants.HashZero;
    }
}

/**
 * 将 bytes32 转换为字符串
 * @param {string} bytes32Str
 * @returns {string}
 */
function bytes32ToString(bytes32Str) {
    if (!bytes32Str || bytes32Str === ethers.constants.HashZero) return '';
    try {
        // 尝试解析为字符串
        return ethers.utils.parseBytes32String(bytes32Str);
    } catch (e) {
        // 如果不是有效字符串，尝试作为 hex 处理
        try {
            const hex = bytes32Str.replace(/^0x/, '');
            // 移除尾部的 0
            const trimmed = hex.replace(/0+$/, '');
            if (trimmed.length === 0) return '';
            // 尝试转换为字符串
            return ethers.utils.toUtf8String('0x' + trimmed);
        } catch (e2) {
            return '';
        }
    }
}

/**
 * 从链上加载指定金库的留言列表（按时间倒序）
 * @param {string} vaultAddr
 * @returns {Promise<Array<{timestamp: number, userAddress: string, action: string, message: string, txHash?: string, blockNumber: number}>>}
 */
async function loadComments(vaultAddr) {
    if (!vaultAddr || !provider) return [];

    const contract = getCommentVaultContract();
    if (!contract) return [];

    try {
        // 获取留言数量
        const count = await contract.getCommentCount(vaultAddr);
        if (count.eq(0)) return [];

        // 获取所有留言（如果数量不多，一次性获取；否则分页）
        let comments = [];
        if (count.lte(100)) {
            // 数量少，一次性获取
            const allComments = await contract.getAllComments(vaultAddr);
            comments = allComments;
        } else {
            // 数量多，分页获取最新的
            const limit = 100;
            const commentsData = await contract.getComments(vaultAddr, 0, limit);
            comments = commentsData;
        }

        // 转换为前端格式（最新的在前）
        return comments.map(c => {
            const action = bytes32ToString(c.action);
            let txHash = '';
            if (c.txHash && c.txHash !== ethers.constants.HashZero) {
                // 从 bytes32 恢复交易哈希（移除前导0）
                const hex = c.txHash.replace(/^0x/, '');
                // 移除前导0，恢复原始哈希（交易哈希应该是64个字符）
                const trimmed = hex.replace(/^0+/, '');
                if (trimmed.length >= 2) { // 至少要有2个字符（0x + 至少1个字符）
                    txHash = '0x' + trimmed.padStart(64, '0');
                }
            }

            return {
                timestamp: c.timestamp.toNumber() * 1000, // 转换为毫秒
                userAddress: c.user,
                action: action || '',
                message: c.message || '',
                txHash: txHash || '',
                blockNumber: c.blockNumber.toNumber()
            };
        }).reverse(); // 反转，最新的在前
    } catch (error) {
        console.error('[留言] 从链上加载失败:', error);
        return [];
    }
}

/**
 * 保存一条留言到链上
 * @param {string} vaultAddr
 * @param {string} userAddress
 * @param {string} action - 'deposit' | 'vote' | 'donate' | 'withdraw'
 * @param {string} message
 * @param {string} [txHash]
 * @returns {Promise<string>} 交易哈希
 */
async function saveComment(vaultAddr, userAddress, action, message, txHash) {
    if (!vaultAddr || !userAddress || !message) {
        throw new Error('参数不完整');
    }

    const contract = getCommentVaultContractWithSigner();
    if (!contract) {
        throw new Error('CommentVault 合约未配置或未连接钱包');
    }

    // 检查留言长度
    if (message.length > 200) {
        throw new Error('留言过长，最多200个字符');
    }

    // 转换为 bytes32
    const actionBytes32 = stringToBytes32(action || '');
    const txHashBytes32 = txHash ? stringToBytes32(txHash) : ethers.constants.HashZero;

    // 调用合约
    const tx = await contract.addComment(
        vaultAddr,
        message,
        actionBytes32,
        txHashBytes32
    );

    // 等待交易确认
    await safeWaitForTransaction(tx);

    return tx.hash;
}

/**
 * 提交留言（来自留言墙或操作成功后的提示）
 */
async function submitComment() {
    const input = document.getElementById('commentInput');
    const addr = vaultAddress;
    if (!addr) return;

    if (!walletAddress || !signer) {
        showModal('请先连接钱包', '留言将显示您的钱包地址，请先连接钱包后再发送。');
        return;
    }

    const message = (input?.value || '').trim();
    if (!message) {
        showModal('留言不能为空', '请输入留言内容');
        return;
    }

    if (message.length > 200) {
        showModal('留言过长', '留言最多200个字符');
        return;
    }

    const ctx = pendingCommentContext;
    const action = ctx?.action || '';
    const txHash = ctx?.txHash || '';

    try {
        showLoading('正在提交留言到链上...');

        const commentTxHash = await saveComment(addr, walletAddress, action, message, txHash);
        console.log('✓ 留言已上链:', commentTxHash);

        hideLoading();
        showModal('留言成功', `您的留言已成功提交到链上！\n\n交易哈希: ${commentTxHash}`);

        if (input) input.value = '';
        // 不清空pendingCommentContext，保留以便后续分享
        updateCommentCharCount();

        // 重新加载留言列表
        await renderComments(addr);
    } catch (error) {
        hideLoading();
        console.error('提交留言失败:', error);

        let errorMsg = '留言提交失败，请重试';
        if (error.message) {
            if (error.message.includes('user rejected') || error.message.includes('User denied')) {
                errorMsg = '您取消了交易';
            } else if (error.message.includes('Message too long')) {
                errorMsg = '留言过长，最多200个字符';
            } else if (error.message.includes('CommentVault 合约未配置')) {
                errorMsg = '留言功能未配置，请联系管理员';
            } else {
                errorMsg = `提交失败: ${error.message}`;
            }
        }

        showModal('留言失败', errorMsg);
    }
}

function updateCommentCharCount() {
    const input = document.getElementById('commentInput');
    const el = document.getElementById('commentCharCount');
    if (!input || !el) return;
    const n = (input.value || '').length;
    el.textContent = `${n}/200`;
}

// ===== 分享到 X（Twitter） =====
const TWITTER_INTENT = 'https://twitter.com/intent/tweet';
const TWITTER_MAX_LEN = 280;

function getVaultPageUrl() {
    const base = window.location.origin + window.location.pathname;
    const q = vaultAddress ? `?vault=${encodeURIComponent(vaultAddress)}` : '';
    return base + q;
}

/**
 * 生成金库信息分享文案（≤280 字符）
 * @param {string} [url] - 可选的金库页面 URL
 */
function generateVaultShareText(url) {
    const m = vaultShareMeta;
    const name = m.displayName || 'ConsensusVault';
    const status = m.consensusReached ? '已解锁' : '锁定中';
    const deposits = m.totalDeposits || '0';
    const tokenSymbol = m.tokenSymbol || '';
    const participants = m.participantCount || 0;
    const depositsText = tokenSymbol ? `总存款 ${deposits} ${tokenSymbol}` : `总存款 ${deposits}`;
    // 新格式：我在 @Consensus_Vault的<name>USDT金库 | 状态 | 总存款 | 参与人数
    let text = `我在 @Consensus_Vault的<${name}>${tokenSymbol}金库 | ${status} | ${depositsText} | ${participants} 人参与`;

    // 如果提供了 URL，添加到文本中（单独一行，前面有空格）
    if (url) {
        text += `\n ${url}`;
    }

    // 确保不超过 Twitter 最大长度
    if (text.length > TWITTER_MAX_LEN) {
        // 如果超长，先截断主文本，保留 URL
        const maxMainTextLength = url ? TWITTER_MAX_LEN - url.length - 2 : TWITTER_MAX_LEN - 3;
        const mainText = text.split('\n')[0];
        if (mainText.length > maxMainTextLength) {
            text = mainText.slice(0, maxMainTextLength - 3) + '…';
            if (url) {
                text += `\n ${url}`;
            }
        }
    }

    return text;
}

/**
 * 生成操作结果分享文案（≤280 字符）
 * @param {string} action - 'deposit' | 'vote' | 'donate' | 'withdraw'
 * @param {string} [amount]
 * @param {string} [txHash]
 */
function generateActionShareText(action, amount, txHash) {
    const labels = { deposit: '存款', vote: '投票', donate: '捐赠', withdraw: '提现' };
    const label = labels[action] || action;
    const m = vaultShareMeta;
    const name = m.displayName || 'ConsensusVault';
    let part = amount ? ` ${amount}` : '';
    let text = `刚刚在 ConsensusVault 完成${label}${part} · ${name}\n\n#ConsensusVault`;
    if (txHash) {
        const shortTx = txHash.slice(0, 10) + '…' + txHash.slice(-8);
        text += `\nTx: ${shortTx}`;
    }
    if (text.length > TWITTER_MAX_LEN) {
        text = text.slice(0, TWITTER_MAX_LEN - 3) + '…';
    }
    return text;
}

/**
 * 打开 Twitter 发推意图页
 * @param {string} text
 * @param {string} [url]
 */
function shareToTwitter(text, url) {
    const u = new URL(TWITTER_INTENT);
    u.searchParams.set('text', (text || '').slice(0, TWITTER_MAX_LEN));
    if (url) u.searchParams.set('url', url);
    window.open(u.toString(), '_blank', 'noopener,noreferrer');
}

// ===== 价格查询功能（DexScreener API） =====
// 价格缓存
const priceCache = new Map();
const PRICE_CACHE_TTL = 10000; // 10秒缓存（充分利用 300次/分钟的限制）
const PRICE_REFRESH_INTERVAL = 30000; // 30秒自动刷新一次价格
let priceRefreshTimer = null; // 价格自动刷新定时器
let currentVaultTokenAddress = null; // 当前金库的代币地址

/**
 * 根据链ID获取DexScreener的chainId
 * @param {number} chainIdDec - 链ID（十进制），可选，默认使用当前 CONFIG
 * @returns {string} DexScreener chainId
 */
function getDexScreenerChainId(chainIdDec = null) {
    const chainId = chainIdDec || CONFIG.chainIdDec;
    if (chainId === 56) return 'bsc';
    if (chainId === 97) return 'bsc-testnet';
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

    // 2. 如果没有 USDT，尝试找 BUSD 交易对
    const busdPairs = pairs.filter(p => {
        const quoteSymbol = p.quoteToken?.symbol?.toUpperCase();
        const baseSymbol = p.baseToken?.symbol?.toUpperCase();
        return quoteSymbol === 'BUSD' || baseSymbol === 'BUSD';
    });

    if (busdPairs.length > 0) {
        return busdPairs.sort((a, b) => {
            const liquidityA = parseFloat(a.liquidity?.usd || 0);
            const liquidityB = parseFloat(b.liquidity?.usd || 0);
            return liquidityB - liquidityA;
        })[0];
    }

    // 3. 如果没有稳定币交易对，选择流动性最高的任何交易对
    const bestByLiquidity = pairs.sort((a, b) => {
        const liquidityA = parseFloat(a.liquidity?.usd || 0);
        const liquidityB = parseFloat(b.liquidity?.usd || 0);
        return liquidityB - liquidityA;
    })[0];

    if (bestByLiquidity && bestByLiquidity.priceUsd) {
        console.log(`[交易对选择] 使用流动性最高的交易对: ${bestByLiquidity.baseToken?.symbol}/${bestByLiquidity.quoteToken?.symbol}`);
        return bestByLiquidity;
    }

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

        // 确保 tokenAddress 是字符串格式
        const normalizedAddress = typeof tokenAddress === 'string' ? tokenAddress : tokenAddress.toString();
        const url = `https://api.dexscreener.com/token-pairs/v1/${dexChainId}/${normalizedAddress}`;

        console.log(`[价格查询] 开始查询: ${normalizedAddress.substring(0, 10)}... (${dexChainId})`);
        console.log(`[价格查询] 完整 URL: ${url}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时（DexScreener API 可能较慢）

        const response = await fetch(url, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`[价格查询] DexScreener API 请求失败: ${response.status} - ${tokenAddress}`);
            return null;
        }

        const data = await response.json();
        console.log(`[价格查询] 完整 API 响应:`, data);

        // DexScreener API 返回数组格式的交易对列表
        let pairs = Array.isArray(data) ? data : (data.pairs || []);
        console.log(`[价格查询] API 返回 ${pairs.length} 个交易对`);

        const bestPair = selectBestPair(pairs);

        if (!bestPair) {
            console.warn(`[价格查询] 未找到有效的交易对: ${tokenAddress}`);
            if (pairs && pairs.length > 0) {
                console.log(`[价格查询] 可用的交易对信息:`, pairs.map(p => ({
                    base: p.baseToken?.symbol,
                    quote: p.quoteToken?.symbol,
                    price: p.priceUsd,
                    liquidity: p.liquidity?.usd
                })));
            } else {
                console.warn(`[价格查询] 响应中没有交易对数据`, {
                    isArray: Array.isArray(data),
                    dataKeys: Object.keys(data || {})
                });
            }
            return null;
        }

        if (!bestPair.priceUsd) {
            console.warn(`[价格查询] 交易对缺少价格信息: ${tokenAddress}`, bestPair);
            return null;
        }

        const priceData = {
            price: parseFloat(bestPair.priceUsd),
            change24h: bestPair.priceChange?.h24 || 0
        };

        console.log(`[价格查询] ✓ 成功获取价格: $${priceData.price} (${bestPair.baseToken?.symbol}/${bestPair.quoteToken?.symbol})`);

        // 更新缓存
        priceCache.set(cacheKey, {
            data: priceData,
            timestamp: now
        });

        return priceData;
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn(`[价格查询] 获取代币价格超时: ${tokenAddress}`);
        } else {
            console.warn(`[价格查询] 获取代币价格失败: ${tokenAddress}`, error);
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
// ===== 网络切换函数 =====
/**
 * 切换网络
 * @param {string} network - 'mainnet' 或 'testnet'
 */
async function switchNetwork(network) {
    if (isNetworkSwitching) {
        console.warn('网络切换正在进行中，请稍候...');
        return;
    }

    if (!NETWORKS[network]) {
        console.error('无效的网络:', network);
        return;
    }

    if (currentNetwork === network) {
        console.log('已经是目标网络:', network);
        return;
    }

    try {
        isNetworkSwitching = true;
        showLoading('切换网络中...');

        console.log(`🔄 切换网络: ${currentNetwork} -> ${network}`);

        // 1. 更新当前网络和配置
        currentNetwork = network;
        CONFIG = { ...NETWORKS[network] };
        VAULT_FACTORY_ADDRESS = CONFIG.factoryAddress;
        // CommentVault 地址也会自动更新（从 CONFIG.commentVaultAddress 读取）

        // 2. 保存到 localStorage
        localStorage.setItem('selectedNetwork', network);

        // 3. 重新初始化 provider
        provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl);
        console.log('✓ 已更新 RPC:', CONFIG.rpcUrl);

        // 4. 清除价格缓存
        priceCache.clear();
        console.log('✓ 已清除价格缓存');

        // 5. 停止价格自动刷新
        stopVaultPriceAutoRefresh();

        // 6. 更新 UI
        updateNetworkUI();

        // 7. 如果已连接钱包，尝试切换钱包网络
        const walletProvider = getWalletProvider();
        if (walletProvider && walletAddress) {
            try {
                // 检查当前钱包网络
                const currentChainId = await walletProvider.request({ method: 'eth_chainId' });

                if (currentChainId !== CONFIG.chainId) {
                    console.log('🔄 切换钱包网络...');
                    try {
                        await walletProvider.request({
                            method: 'wallet_switchEthereumChain',
                            params: [{ chainId: CONFIG.chainId }],
                        });
                    } catch (switchError) {
                        // 如果网络不存在，添加网络
                        if (switchError.code === 4902) {
                            await walletProvider.request({
                                method: 'wallet_addEthereumChain',
                                params: [{
                                    chainId: CONFIG.chainId,
                                    chainName: CONFIG.chainName,
                                    nativeCurrency: {
                                        name: 'BNB',
                                        symbol: 'BNB',
                                        decimals: 18
                                    },
                                    rpcUrls: [CONFIG.rpcUrl],
                                    blockExplorerUrls: [CONFIG.explorer]
                                }],
                            });
                        } else if (switchError.code !== 4001) {
                            // 4001 是用户取消，不抛出
                            throw switchError;
                        }
                    }

                    // 更新 signer
                    const web3Provider = new ethers.providers.Web3Provider(walletProvider, 'any');
                    signer = web3Provider.getSigner();
                }
            } catch (error) {
                console.warn('切换钱包网络失败:', error);
                // 即使钱包网络切换失败，也继续使用新的 RPC
            }
        }

        // 8. 重新加载金库数据
        await loadVaultDetails();
        if (walletAddress) {
            await loadUserInfo();
        }

        hideLoading();
        console.log(`✓ 网络切换完成: ${CONFIG.displayName}`);

        // 显示切换成功提示，然后刷新页面以确保所有状态正确重置
        // 特别是金库地址可能在新网络下无效，需要重新加载
        showModal('切换成功', `已切换到 ${CONFIG.displayName}，页面即将刷新...`).then(() => {
            window.location.reload();
        });

    } catch (error) {
        hideLoading();
        console.error('切换网络失败:', error);
        showModal('切换失败', `切换网络时发生错误: ${error.message}`);
        isNetworkSwitching = false;
    }
}

/**
 * 更新网络 UI 显示
 */
function updateNetworkUI() {
    const networkSelect = document.getElementById('networkSwitch');

    if (networkSelect) {
        networkSelect.value = CONFIG.chainIdDec.toString();
        // 更新下拉菜单的显示文本（通过更新选项）
        const options = networkSelect.querySelectorAll('option');
        options.forEach(opt => {
            if (opt.value === CONFIG.chainIdDec.toString()) {
                opt.selected = true;
            }
        });
    }
}

async function init() {
    try {
        console.log('=== 初始化 vault.js ===');

        // 1. 更新网络 UI
        updateNetworkUI();

        // 2. 获取金库地址
        const params = new URLSearchParams(window.location.search);
        vaultAddress = params.get('vault') || sessionStorage.getItem('selectedVault');

        if (!vaultAddress || !ethers.utils.isAddress(vaultAddress)) {
            showModal('找不到金库', '金库地址无效，请从主页选择金库进入');
            document.getElementById('vaultAddress').textContent = '未提供有效地址';
            return;
        }

        console.log('✓ 金库地址:', vaultAddress);
        document.getElementById('vaultAddress').textContent = vaultAddress;

        // 3. 加载 ABI
        await loadABIs();

        // 4. 初始化只读 provider：固定使用币安官方 RPC（不依赖钱包网络，解决 Binance 钱包问题）
        provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl);
        console.log('✓ 使用固定 RPC 进行只读操作:', CONFIG.rpcUrl);
        console.log('✓ 当前网络:', CONFIG.displayName);

        // 立即渲染留言墙（从链上加载）
        renderComments(vaultAddress);

        const walletProvider = getWalletProvider();
        if (walletProvider) {
            console.log('当前域名:', window.location.origin);
            console.log('当前协议:', window.location.protocol);

            // 设置事件监听
            setupEventListeners();

            // 尝试自动连接钱包
            try {
                const accounts = await walletProvider.request({ method: 'eth_accounts' });
                if (accounts && accounts.length > 0) {
                    walletAddress = accounts[0];
                    // 只初始化 signer（用于写操作），provider 保持不变（用于只读）
                    const web3Provider = new ethers.providers.Web3Provider(walletProvider, 'any');
                    signer = web3Provider.getSigner();
                    console.log('✓ 自动连接钱包:', walletAddress);
                    updateUI();
                }
            } catch (e) {
                console.log('用户未授权钱包:', e.message);
            }
        } else {
            console.warn('⚠ 未检测到钱包，使用只读模式');
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
        const [factoryRes, vaultRes, commentRes] = await Promise.all([
            fetch('./abi/ConsensusVaultFactory.json'),
            fetch('./abi/ConsensusVault.json'),
            fetch('./abi/CommentVault.json').catch(() => null) // CommentVault ABI 可选
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

        // CommentVault ABI（如果存在）
        if (commentRes && commentRes.ok) {
            const commentData = await commentRes.json();
            COMMENT_VAULT_ABI = commentData.abi || commentData;
        } else {
            console.warn('[留言] CommentVault ABI 未找到，留言功能可能不可用');
        }

        // 确保都是数组
        if (!Array.isArray(VAULT_FACTORY_ABI)) {
            console.error('VAULT_FACTORY_ABI 不是数组:', typeof VAULT_FACTORY_ABI);
        }
        if (!Array.isArray(CONSENSUS_VAULT_ABI)) {
            console.error('CONSENSUS_VAULT_ABI 不是数组:', typeof CONSENSUS_VAULT_ABI);
        }
        if (COMMENT_VAULT_ABI.length > 0 && !Array.isArray(COMMENT_VAULT_ABI)) {
            console.error('COMMENT_VAULT_ABI 不是数组:', typeof COMMENT_VAULT_ABI);
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
                            chainName: CONFIG.chainName,
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

        // 网络切换后，只初始化 signer（用于写操作），provider 保持不变（用于只读）
        const web3Provider = new ethers.providers.Web3Provider(walletProvider, 'any');
        signer = web3Provider.getSigner();

        // 检查钱包网络是否匹配（如果不匹配，提示用户只能查看不能操作）
        try {
            const chainId = await walletProvider.request({ method: 'eth_chainId' });
            if (chainId !== CONFIG.chainId) {
                console.warn('⚠ 钱包网络不匹配，只能查看，不能进行链上操作');
                showModal('网络不匹配', `当前钱包网络与 ${CONFIG.displayName} 不匹配，您只能查看数据，无法进行存款、提现等操作。`);
            }
        } catch (e) {
            console.warn('检查钱包网络失败:', e);
        }

        // 使用固定 provider 获取网络信息（用于显示）
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
            vaultShareMeta.displayName = displayName;
            vaultShareMeta.tokenSymbol = tokenSymbol;
        } catch (e) {
            console.warn('读取金库信息失败，保留默认标题', e);
        }

        // 获取合约实际余额（用于计算真实总市值，包含捐赠部分）
        let contractBalance = totalPrincipal; // 默认使用 totalPrincipal 作为后备
        if (depositTokenAddr && depositTokenAddr !== ethers.constants.AddressZero) {
            try {
                const depositToken = new ethers.Contract(
                    depositTokenAddr,
                    ['function balanceOf(address) view returns (uint256)'],
                    provider
                );
                contractBalance = await depositToken.balanceOf(vaultAddress);
            } catch (e) {
                console.warn('获取合约余额失败，使用 totalPrincipal 作为后备:', e);
            }
        }

        // 获取代币小数位数（如果 depositTokenAddr 为空，使用默认值18）
        const decimals = depositTokenAddr ? await getTokenDecimals(depositTokenAddr, provider) : 18;

        const totalPrincipalNum = parseFloat(formatTokenAmount(totalPrincipal, decimals));
        const contractBalanceNum = parseFloat(formatTokenAmount(contractBalance, decimals));
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
        vaultShareMeta.totalDeposits = formatPrecise(totalPrincipalNum);
        vaultShareMeta.participantCount = participantCount;
        vaultShareMeta.consensusReached = consensusReached;
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

        // 保存金库状态到全局变量（用于按钮点击检查）
        const canWithdraw = consensusReached && (unlockAtNum === 0 || nowSec >= unlockAtNum);
        vaultState = {
            consensusReached: consensusReached,
            unlockAt: unlockAtNum,
            canWithdraw: canWithdraw
        };

        // 设置按钮状态（不设置 disabled，以便点击时能显示提示）
        if (elem('depositBtn')) {
            elem('depositBtn').setAttribute('data-disabled-reason', consensusReached ? 'unlocked' : '');
            if (consensusReached) {
                elem('depositBtn').classList.add('btn-disabled');
            } else {
                elem('depositBtn').classList.remove('btn-disabled');
            }
        }
        if (elem('voteBtn')) {
            elem('voteBtn').setAttribute('data-disabled-reason', consensusReached ? 'unlocked' : '');
            if (consensusReached) {
                elem('voteBtn').classList.add('btn-disabled');
            } else {
                elem('voteBtn').classList.remove('btn-disabled');
            }
        }
        if (elem('donateBtn')) {
            elem('donateBtn').setAttribute('data-disabled-reason', consensusReached ? 'unlocked' : '');
            if (consensusReached) {
                elem('donateBtn').classList.add('btn-disabled');
            } else {
                elem('donateBtn').classList.remove('btn-disabled');
            }
        }
        if (elem('withdrawBtn')) {
            const withdrawDisabled = !consensusReached || (unlockAtNum > 0 && nowSec < unlockAtNum);
            if (withdrawDisabled) {
                if (!consensusReached) {
                    elem('withdrawBtn').setAttribute('data-disabled-reason', 'not-unlocked');
                } else if (unlockAtNum > 0 && nowSec < unlockAtNum) {
                    elem('withdrawBtn').setAttribute('data-disabled-reason', 'waiting-unlock');
                }
                elem('withdrawBtn').classList.add('btn-disabled');
            } else {
                elem('withdrawBtn').setAttribute('data-disabled-reason', '');
                elem('withdrawBtn').classList.remove('btn-disabled');
            }
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

        // 异步获取价格并计算总市值（不阻塞主流程）
        currentVaultTokenAddress = depositTokenAddr; // 保存当前金库的代币地址
        if (depositTokenAddr) {
            if (elem('totalMarketValue')) {
                // 先显示加载中
                elem('totalMarketValue').textContent = '加载中...';
            }
            // 异步执行，不阻塞渲染（使用合约余额计算总市值）
            refreshVaultPrice(depositTokenAddr, contractBalanceNum).catch(err => {
                console.warn('价格加载失败:', err);
                if (elem('totalMarketValue')) {
                    elem('totalMarketValue').textContent = 'N/A';
                }
            });
        } else {
            if (elem('totalMarketValue')) {
                elem('totalMarketValue').textContent = 'N/A';
            }
        }

        // 启动价格自动刷新（使用合约余额）
        startVaultPriceAutoRefresh(depositTokenAddr, contractBalanceNum);

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

        // 异步获取价格并计算用户持仓市值（不阻塞主流程）
        // 持仓市值 = 本金 + 获得的捐赠
        const totalAmountNum = principalNum + pendingReward;
        currentVaultData.userPrincipalNum = totalAmountNum; // 保存用户总资产数据（本金+捐赠）
        if (depositTokenAddr && totalAmountNum > 0) {
            if (document.getElementById('myDepositValue')) {
                document.getElementById('myDepositValue').textContent = '加载中...';
            }
            // 异步执行，不阻塞渲染
            refreshUserPrice(depositTokenAddr, totalAmountNum).catch(err => {
                console.warn('用户价格加载失败:', err);
                if (document.getElementById('myDepositValue')) {
                    document.getElementById('myDepositValue').textContent = 'N/A';
                }
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

const ACTION_LABELS = { deposit: '存款', vote: '投票', donate: '捐赠', withdraw: '提现' };

/**
 * 渲染留言列表并更新计数（从链上加载）
 * @param {string} vaultAddr
 */
async function renderComments(vaultAddr) {
    const listEl = document.getElementById('commentsList');
    const countEl = document.getElementById('commentCount');
    if (!listEl) return;

    // 从链上加载留言
    const comments = await loadComments(vaultAddr || vaultAddress);
    if (countEl) countEl.textContent = `(${comments.length})`;

    if (!comments.length) {
        listEl.innerHTML = '<p class="comments-empty">暂无留言，来写下第一条吧～</p>';
        return;
    }

    const explorerUrl = CONFIG.explorer;
    let html = '';
    comments.forEach((c) => {
        const addr = formatAddress(c.userAddress);
        const action = ACTION_LABELS[c.action] || c.action || '—';
        const time = c.timestamp ? new Date(c.timestamp).toLocaleString() : '—';
        const msg = (c.message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        const txLink = c.txHash && explorerUrl
            ? `<a href="${explorerUrl}/tx/${c.txHash}" target="_blank" rel="noopener" class="comment-tx-link">链上哈希</a>`
            : '';
        html += `<div class="comment-card">
            <div class="comment-meta">
                <span class="comment-addr">${addr}</span>
                <span class="comment-action">${action}</span>
                <span class="comment-time">${time}</span>
                ${txLink}
            </div>
            ${msg ? `<div class="comment-body">${msg}</div>` : ''}
        </div>`;
    });
    listEl.innerHTML = html;
}

function setupEventListeners() {
    // 网络切换下拉菜单
    const networkSelect = document.getElementById('networkSwitch');
    if (networkSelect) {
        networkSelect.addEventListener('change', async (e) => {
            const selectedChainId = parseInt(e.target.value);
            let targetNetwork = null;

            // 根据 chainId 确定目标网络
            if (selectedChainId === 56) {
                targetNetwork = 'mainnet';
            } else if (selectedChainId === 97) {
                targetNetwork = 'testnet';
            }

            if (targetNetwork && targetNetwork !== currentNetwork) {
                await switchNetwork(targetNetwork);
            }
        });
    }

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

    // 分享金库到 X
    const shareVaultBtn = document.getElementById('shareVaultBtn');
    if (shareVaultBtn) {
        shareVaultBtn.addEventListener('click', () => {
            const url = getVaultPageUrl();
            const text = generateVaultShareText(url);
            shareToTwitter(text); // URL 已包含在 text 中，不再单独传递
        });
    }

    // 通用按钮点击处理（支持移动端触摸）
    const addButtonHandler = (btnId, handler) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        const handleClick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            handler(btn);
        };
        btn.addEventListener('click', handleClick);
        btn.addEventListener('touchend', handleClick);
    };

    // 检查禁用状态并显示提示
    const checkDisabled = (btn, messages) => {
        const reason = btn.getAttribute('data-disabled-reason');
        if (reason && messages[reason]) {
            showModal(messages[reason].title, messages[reason].message);
            return true;
        }
        if (reason === 'waiting-unlock') {
            const unlockTime = vaultState.unlockAt > 0 ? formatTimestamp(vaultState.unlockAt) : '未知时间';
            const nowSec = Math.floor(Date.now() / 1000);
            const remainingSec = Math.max(vaultState.unlockAt - nowSec, 0);
            const remainingHours = Math.ceil(remainingSec / 3600);
            showModal('提现时间未到', `金库已解锁，但提现时间尚未到达。\n\n解锁时间：${unlockTime}\n\n约 ${remainingHours} 小时后可提现。`);
            return true;
        }
        return false;
    };

    // 存款按钮
    addButtonHandler('depositBtn', async (btn) => {
        if (checkDisabled(btn, { unlocked: { title: '无法存款', message: '这个金库已经达成共识解锁了，不再接受新的存款。' } })) return;
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

    // 投票按钮
    addButtonHandler('voteBtn', async (btn) => {
        if (checkDisabled(btn, { unlocked: { title: '无法投票', message: '金库已达成共识解锁了，不再接受投票。' } })) return;
        if (!walletAddress) {
            showModal('还没连接钱包', '请先点击右上角连接您的钱包');
            return;
        }
        await vote();
    });

    // 提现按钮
    addButtonHandler('withdrawBtn', async (btn) => {
        const reason = btn.getAttribute('data-disabled-reason');
        if (reason === 'not-unlocked') {
            showModal('无法提现', '金库尚未达成共识解锁，无法提现。\n\n请等待共识达成后，金库解锁才能提现本金和收益。');
            return;
        }
        if (checkDisabled(btn, {})) return;
        if (!walletAddress) {
            showModal('还没连接钱包', '请先点击右上角连接您的钱包');
            return;
        }
        await withdraw();
    });

    // 捐赠按钮
    addButtonHandler('donateBtn', async (btn) => {
        if (checkDisabled(btn, { unlocked: { title: '无法捐赠', message: '这个金库已经达成共识解锁了，不再接受捐赠。\n\n感谢您的支持！' } })) return;
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

    // 留言：字数统计
    const commentInput = document.getElementById('commentInput');
    const commentCharCount = document.getElementById('commentCharCount');
    if (commentInput && commentCharCount) {
        const updateCharCount = () => {
            const n = (commentInput.value || '').length;
            commentCharCount.textContent = `${n}/200`;
        };
        commentInput.addEventListener('input', updateCharCount);
        commentInput.addEventListener('paste', () => setTimeout(updateCharCount, 0));
        updateCharCount();
    }

    // 留言：提交
    addButtonHandler('submitCommentBtn', () => submitComment());

    // 留言区分享按钮（当有pendingCommentContext时显示）
    const commentShareBtn = document.getElementById('commentShareBtn');
    if (commentShareBtn) {
        const updateCommentShareBtn = () => {
            if (pendingCommentContext && pendingCommentContext.txHash) {
                commentShareBtn.style.display = 'inline-flex';
            } else {
                commentShareBtn.style.display = 'none';
            }
        };
        commentShareBtn.addEventListener('click', () => {
            if (pendingCommentContext) {
                const text = generateActionShareText(pendingCommentContext.action, pendingCommentContext.amount, pendingCommentContext.txHash);
                shareToTwitter(text, getVaultPageUrl());
            }
        });
        // 初始检查
        updateCommentShareBtn();
        // 使用MutationObserver或定期检查（简化：在关键位置调用updateCommentShareBtn）
        // 在showSuccessWithCommentAndShare中已经会更新显示，这里作为后备
        window.updateCommentShareBtn = updateCommentShareBtn;
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
                // 重新连接钱包（只更新 signer，不改变 provider）
                const web3Provider = new ethers.providers.Web3Provider(walletProvider, 'any');
                signer = web3Provider.getSigner();
                updateUI();
                loadUserInfo(); // 刷新用户信息（只读依然走固定 RPC）
            }
        });

        walletProvider.on('chainChanged', async (chainId) => {
            console.log('钱包网络已切换:', chainId);
            // 检查是否匹配当前配置的网络
            if (chainId !== CONFIG.chainId) {
                console.warn('⚠ 钱包网络与当前配置不匹配');
                // 不自动切换，让用户手动选择
            } else {
                // 网络匹配，更新 signer
                const web3Provider = new ethers.providers.Web3Provider(walletProvider, 'any');
                signer = web3Provider.getSigner();
                console.log('✓ 钱包网络已匹配当前配置');
            }
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

function showModal(title, message, options = {}) {
    const overlay = document.getElementById('modalOverlay');
    if (!overlay) return Promise.resolve();

    const titleEl = overlay.querySelector('.modal-title');
    const bodyEl = overlay.querySelector('.modal-body');

    if (titleEl) titleEl.textContent = title;
    if (options.htmlBody != null) {
        bodyEl.innerHTML = options.htmlBody;
    } else {
        bodyEl.textContent = message;
    }

    overlay.style.display = 'flex'; // 使用 flex 确保正确显示

    return new Promise((resolve) => {
        let isClosed = false;
        const closeModal = () => {
            if (isClosed) return;
            isClosed = true;
            overlay.style.display = 'none';
            resolve();
        };

        if (typeof options.onRender === 'function') {
            options.onRender(bodyEl, closeModal);
        }

        // 手动关闭按钮 - 支持点击和触摸事件
        const closeBtn = overlay.querySelector('.modal-close');
        if (closeBtn) {
            const newCloseBtn = closeBtn.cloneNode(true);
            closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
            newCloseBtn.addEventListener('click', closeModal);
            newCloseBtn.addEventListener('touchend', (e) => {
                e.preventDefault();
                closeModal();
            });
        }

        // 点击背景关闭 - 支持点击和触摸事件
        const handleOverlayClick = (e) => {
            if (e.target === overlay) closeModal();
        };
        overlay.removeEventListener('click', handleOverlayClick);
        overlay.removeEventListener('touchend', handleOverlayClick);
        overlay.addEventListener('click', handleOverlayClick);
        overlay.addEventListener('touchend', (e) => {
            if (e.target === overlay) {
                e.preventDefault();
                closeModal();
            }
        });

        if (options.autoClose) {
            setTimeout(closeModal, options.autoClose);
        }
    });
}

/**
 * 生成默认分享/留言内容
 * @param {{ action: string, amount?: string, txHash?: string }} ctx
 * @returns {string}
 */
function generateDefaultShareText(ctx) {
    if (!ctx) return '';
    const actionLabels = { deposit: '存款', vote: '投票', donate: '捐赠', withdraw: '提现' };
    const actionLabel = actionLabels[ctx.action] || ctx.action;
    const vaultName = vaultShareMeta.displayName || 'ConsensusVault';
    const tokenSymbol = vaultShareMeta.tokenSymbol || '';
    const amountPart = ctx.amount && tokenSymbol
        ? `，金额：${ctx.amount} ${tokenSymbol}`
        : ctx.amount ? `，金额：${ctx.amount}` : '';
    const line3 = `完成了${actionLabel}操作${amountPart}`;
    const line4 = ctx.txHash ? `链上哈希：${ctx.txHash}` : '';
    if (line4) {
        return `我刚在@Consensus_Vault\n<${vaultName}> 金库\n${line3}\n${line4}`;
    }
    return `我刚在@Consensus_Vault\n<${vaultName}> 金库\n${line3}`;
}

/**
 * 仅关闭弹窗时保存的简短留言（如 "存款 1000 USDT"）
 * @param {{ action: string, amount?: string }} ctx
 * @returns {string}
 */
function shortCommentForClose(ctx) {
    if (!ctx) return '';
    const actionLabels = { deposit: '存款', vote: '投票', donate: '捐赠', withdraw: '提现' };
    const label = actionLabels[ctx.action] || ctx.action;
    const tokenSymbol = vaultShareMeta.tokenSymbol || '';
    if ((ctx.action === 'deposit' || ctx.action === 'donate' || ctx.action === 'withdraw') && ctx.amount && tokenSymbol) {
        return `${label} ${ctx.amount} ${tokenSymbol}`;
    }
    if ((ctx.action === 'deposit' || ctx.action === 'donate' || ctx.action === 'withdraw') && ctx.amount) {
        return `${label} ${ctx.amount}`;
    }
    return label;
}

/**
 * 操作成功后弹窗：输入框 + 留言按钮 + 分享到 X 按钮
 * @param {string} title
 * @param {string} message
 * @param {{ action: string, amount?: string, txHash?: string }} ctx
 */
function showSuccessWithCommentAndShare(title, message, ctx) {
    pendingCommentContext = ctx ? { action: ctx.action, amount: ctx.amount, txHash: ctx.txHash } : null;

    // 生成默认内容
    const defaultText = generateDefaultShareText(ctx);

    const safe = (message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const html = `
        <p class="modal-success-message">${safe}</p>
        <div class="modal-share-input-area">
            <label for="modalShareInput" style="display: block; margin-bottom: 8px; font-size: 13px; color: var(--text-muted);">编辑分享内容：</label>
            <textarea id="modalShareInput" class="modal-share-input" rows="4" maxlength="200" placeholder="编辑分享内容...">${defaultText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
            <div class="modal-share-char-count">
                <span id="modalShareCharCount">${defaultText.length}/200</span>
            </div>
        </div>
        <div class="modal-success-actions">
            <button type="button" id="modalBtnComment" class="btn btn-primary"><i class="fas fa-comment"></i> 留言</button>
            <button type="button" id="modalBtnShare" class="btn btn-primary"><i class="fab fa-x-twitter"></i> 分享到 X</button>
        </div>`;

    let hasClickedComment = false;
    let modalInput = null;

    // 保存留言（长文案，用输入框内容）
    const saveCommentLong = async () => {
        if (!ctx || !vaultAddress || !walletAddress || !signer || hasClickedComment) return;
        try {
            let text = (modalInput?.value || '').trim() || defaultText;
            if (!text) return;

            // 截断到200个字符（智能合约限制）
            if (text.length > 200) {
                text = text.substring(0, 200);
                // 更新输入框显示截断后的内容
                if (modalInput) {
                    modalInput.value = text;
                    // 更新字符计数
                    const charCount = document.querySelector('#modalShareCharCount');
                    if (charCount) {
                        charCount.textContent = `200/200`;
                    }
                }
            }

            showLoading('正在提交留言到链上...');
            await saveComment(vaultAddress, walletAddress, ctx.action, text, ctx.txHash);
            hideLoading();
            await renderComments(vaultAddress);
            hasClickedComment = true;
        } catch (error) {
            hideLoading();
            console.error('保存留言失败:', error);
            showModal('留言失败', error.message || '提交留言时发生错误');
        }
    };

    // 仅关闭时保存的短文案（如 "存款 1000 USDT"）
    const saveCommentShortOnClose = async () => {
        if (!ctx || !vaultAddress || !walletAddress || !signer || hasClickedComment) return;
        try {
            const text = shortCommentForClose(ctx);
            if (!text) return;

            // 静默保存，不显示加载提示
            await saveComment(vaultAddress, walletAddress, ctx.action, text, ctx.txHash);
            await renderComments(vaultAddress);
        } catch (error) {
            console.warn('自动保存留言失败:', error);
            // 静默失败，不打扰用户
        }
    };

    showModal(title, '', {
        htmlBody: html,
        onRender(bodyEl, closeModal) {
            const input = bodyEl.querySelector('#modalShareInput');
            const charCount = bodyEl.querySelector('#modalShareCharCount');
            const btnComment = bodyEl.querySelector('#modalBtnComment');
            const btnShare = bodyEl.querySelector('#modalBtnShare');

            modalInput = input;

            if (input && charCount) {
                const updateCharCount = () => {
                    let value = input.value || '';
                    const n = value.length;

                    // 如果超过200字符，截断并更新输入框
                    if (n > 200) {
                        value = value.substring(0, 200);
                        input.value = value;
                        charCount.textContent = `200/200`;
                        charCount.style.color = 'var(--warning, #ff6b6b)';
                    } else {
                        charCount.textContent = `${n}/200`;
                        // 接近限制时显示警告色
                        if (n >= 180) {
                            charCount.style.color = 'var(--warning, #ff6b6b)';
                        } else {
                            charCount.style.color = '';
                        }
                    }
                };

                // 监听输入事件，实时限制长度
                input.addEventListener('input', (e) => {
                    if (input.value.length > 200) {
                        input.value = input.value.substring(0, 200);
                    }
                    updateCharCount();
                });

                // 监听粘贴事件，防止粘贴超长内容
                input.addEventListener('paste', (e) => {
                    setTimeout(() => {
                        if (input.value.length > 200) {
                            input.value = input.value.substring(0, 200);
                        }
                        updateCharCount();
                    }, 0);
                });

                updateCharCount();
            }

            const disableBtn = (btn) => {
                if (!btn) return;
                btn.disabled = true;
                btn.classList.add('btn-disabled');
                btn.style.opacity = '0.5';
                btn.style.cursor = 'not-allowed';
            };

            // 留言：只保存，不关弹窗；仅留言按钮变灰失效
            if (btnComment) {
                btnComment.addEventListener('click', async () => {
                    await saveCommentLong();
                    disableBtn(btnComment);
                });
                btnComment.addEventListener('touchend', async (e) => {
                    e.preventDefault();
                    await saveCommentLong();
                    disableBtn(btnComment);
                });
            }

            // 分享：只分享，不关弹窗；文案已含金库地址，不再传 url 避免重复；仅分享按钮变灰失效
            if (btnShare) {
                btnShare.addEventListener('click', () => {
                    const text = (input?.value || '').trim() || defaultText;
                    shareToTwitter(text);
                    disableBtn(btnShare);
                });
                btnShare.addEventListener('touchend', (e) => { e.preventDefault(); btnShare.click(); });
            }
        }
    }).then(() => {
        // 仅当用户直接关闭弹窗（未点留言）时，保存短文案如 "存款 1000 USDT"
        saveCommentShortOnClose();
    });
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
        showSuccessWithCommentAndShare('存款成功', `已成功存款 ${amount}\n\n欢迎参与投票来支持这个金库的共识。`, { action: 'deposit', amount, txHash: depositTx.hash });
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
            showModal('金库已解锁', '金库已达成共识解锁了，不再接受投票。');
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
        showSuccessWithCommentAndShare('投票成功', '已成功投票支持共识！\n\n如果共识达成，金库将解锁，您可以提现本金和收益。', { action: 'vote', txHash: voteTx.hash });

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
        const totalAmountStr = formatTokenAmount(expectedAmount, tokenDecimals);
        showSuccessWithCommentAndShare('提现成功', '已成功提现全部本金和收益', { action: 'withdraw', amount: totalAmountStr, txHash: withdrawTx.hash });

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
        showSuccessWithCommentAndShare('捐赠成功', `已成功捐赠 ${amount}，感谢您的支持！`, { action: 'donate', amount, txHash: donateTx.hash });
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

/**
 * 刷新金库总市值
 * @param {string} tokenAddress - 代币地址
 * @param {number} contractBalanceNum - 合约实际余额（包含捐赠部分），用于计算真实总市值
 */
async function refreshVaultPrice(tokenAddress, contractBalanceNum) {
    if (!tokenAddress) return;

    try {
        const priceData = await getTokenPrice(tokenAddress);
        const elem = (id) => document.getElementById(id);
        if (elem('totalMarketValue')) {
            if (priceData) {
                const totalValue = calculateTotalValue(contractBalanceNum, priceData.price);
                elem('totalMarketValue').textContent = totalValue;
            } else {
                elem('totalMarketValue').textContent = 'N/A';
            }
        }
    } catch (err) {
        console.warn('获取价格失败:', err);
        const elem = (id) => document.getElementById(id);
        if (elem('totalMarketValue')) {
            elem('totalMarketValue').textContent = 'N/A';
        }
    }
}

/**
 * 刷新用户持仓市值
 * @param {string} tokenAddress - 代币地址
 * @param {number} totalAmountNum - 用户总资产（本金 + 获得的捐赠）
 */
async function refreshUserPrice(tokenAddress, totalAmountNum) {
    if (!tokenAddress || totalAmountNum <= 0) return;

    try {
        const priceData = await getTokenPrice(tokenAddress);
        const myDepositValueEl = document.getElementById('myDepositValue');
        if (myDepositValueEl && priceData) {
            const userValue = calculateTotalValue(totalAmountNum, priceData.price);
            myDepositValueEl.textContent = `我的持仓市值: ${userValue}`;
            myDepositValueEl.style.display = 'block';
        } else if (myDepositValueEl) {
            myDepositValueEl.style.display = 'none';
        }
    } catch (err) {
        console.warn('获取用户持仓市值失败:', err);
    }
}

// 保存当前金库的数据，用于自动刷新
let currentVaultData = {
    tokenAddress: null,
    totalPrincipalNum: 0,
    userPrincipalNum: 0
};

/**
 * 启动金库详情页价格自动刷新
 * @param {string} tokenAddress - 代币地址
 * @param {number} contractBalanceNum - 合约实际余额（包含捐赠部分）
 */
function startVaultPriceAutoRefresh(tokenAddress, contractBalanceNum) {
    // 清除旧的定时器
    if (priceRefreshTimer) {
        clearInterval(priceRefreshTimer);
    }

    if (!tokenAddress) return;

    // 保存当前金库数据
    currentVaultData.tokenAddress = tokenAddress;
    currentVaultData.totalPrincipalNum = contractBalanceNum; // 实际存储的是合约余额

    // 每30秒自动刷新一次价格
    priceRefreshTimer = setInterval(async () => {
        if (!currentVaultData.tokenAddress) return;

        // 刷新金库总市值（使用合约余额）
        if (currentVaultData.totalPrincipalNum > 0) {
            await refreshVaultPrice(currentVaultData.tokenAddress, currentVaultData.totalPrincipalNum);
        }

        // 刷新用户持仓市值
        if (currentVaultData.userPrincipalNum > 0) {
            await refreshUserPrice(currentVaultData.tokenAddress, currentVaultData.userPrincipalNum);
        }
    }, PRICE_REFRESH_INTERVAL);

    console.log(`[价格刷新] 已启动自动刷新，每 ${PRICE_REFRESH_INTERVAL / 1000} 秒刷新一次`);
}

/**
 * 停止价格自动刷新定时器
 */
function stopVaultPriceAutoRefresh() {
    if (priceRefreshTimer) {
        clearInterval(priceRefreshTimer);
        priceRefreshTimer = null;
        console.log('[价格刷新] 已停止自动刷新');
    }
}

// 页面卸载时清理定时器
window.addEventListener('beforeunload', () => {
    stopVaultPriceAutoRefresh();
});

// ===== 导出全局函数 =====
window.goBack = goBack;
window.connectWallet = connectWallet;
window.deposit = deposit;
window.vote = vote;
window.withdraw = withdraw;
window.donate = donate;
