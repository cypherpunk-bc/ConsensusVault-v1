// ============================================
// ConsensusVault 前端 
// 架构：VaultManager
// ============================================

// ===== 配置部分 =====
// 网络配置对象
const NETWORKS = {
    mainnet: {
        chainId: '0x38',
        chainIdDec: 56,
        chainName: 'BNB Smart Chain',
        displayName: 'BSC 主网',
        rpcUrl: 'https://bsc-dataseed.bnbchain.org',
        explorer: 'https://bscscan.com',
        factoryAddress: '0x2aBFa239b09A1D4B03c8F65Ef59e855D6bBf75Ab',// 主网工厂合约地址（需要替换为实际地址）
        // 主网留言合约地址
    },
    testnet: {
        chainId: '0x61',
        chainIdDec: 97,
        chainName: 'BSC Testnet',
        displayName: 'BSC 测试网',
        rpcUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545',
        explorer: 'https://testnet.bscscan.com',
        factoryAddress: '0xc9FA3e06A09a5b6257546C6eB8De2868275A2f98', // 测试网工厂合约地址
         // 测试网留言合约地址
    }
};

// 当前网络（从 localStorage 读取，默认zhu网）
let currentNetwork = localStorage.getItem('selectedNetwork') || 'mainnet';
if (!NETWORKS[currentNetwork]) {
    currentNetwork = 'mainnet';
}
let CONFIG = { ...NETWORKS[currentNetwork] };
let VAULT_FACTORY_ADDRESS = CONFIG.factoryAddress;
// Multicall3 合约地址（所有链通用）
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Multicall3 ABI（简化版，只包含 aggregate 函数）
const MULTICALL3_ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "address", "name": "target", "type": "address" },
                    { "internalType": "bytes", "name": "callData", "type": "bytes" }
                ],
                "internalType": "struct IMulticall3.Call[]",
                "name": "calls",
                "type": "tuple[]"
            }
        ],
        "name": "aggregate",
        "outputs": [
            { "internalType": "uint256", "name": "blockNumber", "type": "uint256" },
            { "internalType": "bytes[]", "name": "returnData", "type": "bytes[]" }
        ],
        "stateMutability": "payable",
        "type": "function"
    }
];

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

// 缓存钱包提供者，避免重复检测和日志
let cachedWalletProvider = null;
let cachedWalletName = null;

/**
 * 检测并返回可用的钱包提供者
 * 支持 MetaMask、OKX Wallet 等多种钱包
 * @param {boolean} forceRefresh - 是否强制刷新缓存（默认 false）
 * @param {boolean} silent - 是否静默模式（不打印日志，默认 false）
 */
function getWalletProvider(forceRefresh = false, silent = false) {
    // 如果已有缓存且不强制刷新，直接返回
    if (!forceRefresh && cachedWalletProvider !== null) {
        return cachedWalletProvider;
    }

    // 重新检测
    for (const wallet of WALLET_PRIORITY) {
        if (wallet.check()) {
            if (!silent) {
                console.log(`✓ 检测到 ${wallet.name} 钱包`);
            }
            cachedWalletProvider = wallet.getProvider();
            cachedWalletName = wallet.name;
            return cachedWalletProvider;
        }
    }

    if (!silent) {
        console.warn('⚠ 未检测到任何钱包');
    }
    cachedWalletProvider = null;
    cachedWalletName = null;
    return null;
}

/**
 * 检查钱包是否可用
 */
function isWalletAvailable() {
    // 使用静默模式，不打印日志
    const provider = getWalletProvider(false, true);
    return provider !== null;
}

// ===== 全局状态 =====
let provider, signer, walletAddress;
let vaultManager = null;
let isNetworkSwitching = false; // 网络切换标志，防止重复切换

// 用户数据缓存
const userCache = {
    participatedVaults: [], // 用户参与的金库列表
    userEvents: []          // 用户相关的所有事件
};

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

// ===== 价格查询功能（DexScreener API） =====
// 价格缓存
const priceCache = new Map();
const PRICE_CACHE_TTL = 10000; // 10秒缓存（充分利用 300次/分钟的限制）
const PRICE_REFRESH_INTERVAL = 30000; // 30秒自动刷新一次价格
let priceRefreshTimer = null; // 价格自动刷新定时器

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
 * 批量获取代币价格
 * @param {string[]} tokenAddresses - 代币地址数组
 * @param {string} chainId - 链ID，可选
 * @returns {Promise<Map<string, {price: number, change24h: number}>>}
 */
async function getTokenPricesBatch(tokenAddresses, chainId = null) {
    const priceMap = new Map();
    const toFetch = [];

    // 过滤已缓存的地址
    for (const addr of tokenAddresses) {
        const cacheKey = addr.toLowerCase();
        if (priceCache.has(cacheKey)) {
            const cached = priceCache.get(cacheKey);
            const now = Date.now();
            if (now - cached.timestamp < PRICE_CACHE_TTL) {
                priceMap.set(addr, cached.data);
            } else {
                toFetch.push(addr);
            }
        } else {
            toFetch.push(addr);
        }
    }

    console.log(`[批量价格] 需要获取 ${toFetch.length} 个代币，${priceMap.size} 个来自缓存`);

    // 批量获取价格（控制速率：300次/分钟 = 5次/秒）
    const batchSize = 5;
    for (let i = 0; i < toFetch.length; i += batchSize) {
        const batch = toFetch.slice(i, i + batchSize);
        const promises = batch.map(addr => getTokenPrice(addr, chainId));
        const results = await Promise.all(promises);

        let batchSuccessCount = 0;
        results.forEach((priceData, index) => {
            if (priceData) {
                priceMap.set(batch[index], priceData);
                batchSuccessCount++;
            }
        });

        console.log(`[批量价格] 批次 ${Math.floor(i / batchSize) + 1}: ${batchSuccessCount}/${batch.length} 成功`);

        // 如果不是最后一批，等待一下避免超过速率限制
        if (i + batchSize < toFetch.length) {
            await new Promise(resolve => setTimeout(resolve, 200)); // 等待200ms
        }
    }

    console.log(`[批量价格] 总计获取到 ${priceMap.size}/${tokenAddresses.length} 个代币的价格`);
    return priceMap;
}

/**
 * 刷新所有金库的价格
 */
async function refreshAllVaultPrices() {
    if (!allVaults || allVaults.length === 0) return;

    const uniqueTokenAddresses = [...new Set(allVaults.map(v => v.depositToken).filter(Boolean))];
    if (uniqueTokenAddresses.length === 0) return;

    console.log(`[自动刷新] 开始刷新 ${uniqueTokenAddresses.length} 个代币的价格...`);

    try {
        // 清除这些代币的缓存，强制重新获取
        uniqueTokenAddresses.forEach(addr => {
            priceCache.delete(addr.toLowerCase());
        });

        const priceMap = await getTokenPricesBatch(uniqueTokenAddresses);

        let successCount = 0;
        let failCount = 0;

        // 更新所有金库的价格数据
        allVaults.forEach(vault => {
            if (vault.depositToken && priceMap.has(vault.depositToken)) {
                vault.priceData = priceMap.get(vault.depositToken);
                if (vault.priceData) {
                    successCount++;

                    // 更新金库列表卡片（vault-total-value-）
                    const vaultAddressLower = vault.address.toLowerCase();
                    const valueEls = document.querySelectorAll(`[id*="vault-total-value-"]`);

                    valueEls.forEach(valueEl => {
                        if (valueEl.id.includes(vaultAddressLower) || valueEl.id.toLowerCase().includes(vaultAddressLower)) {
                            const totalValue = calculateTotalValue(vault.contractBalanceFormatted || vault.totalDepositsFormatted, vault.priceData.price);
                            const valueSpan = valueEl.querySelector('.value');
                            if (valueSpan) {
                                console.log(`[自动刷新] 更新金库总市值 ${vault.address.substring(0, 10)}... 为 ${totalValue}`);
                                valueSpan.textContent = totalValue;
                                valueSpan.classList.remove('price-loading');
                            }
                        }
                    });

                    // 更新用户金库卡片（user-vault-value-）
                    const userVaultEls = document.querySelectorAll(`[id*="user-vault-value-"]`);
                    userVaultEls.forEach(userVaultEl => {
                        if (userVaultEl.id.includes(vaultAddressLower) || userVaultEl.id.toLowerCase().includes(vaultAddressLower)) {
                            // 需要找到对应的 userVault 对象来获取 depositAmount
                            const userVaultCard = userVaultEl.closest('.card-body');
                            if (userVaultCard) {
                                // 从金库列表中找到对应的用户金库数据
                                const participatedVault = userCache.participatedVaults?.find(v =>
                                    v.address.toLowerCase() === vault.address.toLowerCase()
                                );
                                if (participatedVault) {
                                    // 持仓市值 = 本金 + 获得的捐赠
                                    const totalAmount = participatedVault.totalAmount || participatedVault.depositAmount;
                                    const userValue = calculateTotalValue(totalAmount, vault.priceData.price);
                                    const valueSpan = userVaultEl.querySelector('.value');
                                    if (valueSpan) {
                                        console.log(`[自动刷新] 更新用户持仓市值 ${vault.address.substring(0, 10)}... 为 ${userValue}`);
                                        valueSpan.textContent = userValue;
                                        valueSpan.classList.remove('price-loading');
                                    }
                                }
                            }
                        }
                    });
                } else {
                    failCount++;
                }
            }
        });

        console.log(`[自动刷新] ✓ 价格刷新完成 (成功: ${successCount}, 失败: ${failCount})`);
    } catch (error) {
        console.warn('[自动刷新] 价格刷新失败:', error);
    }
}

/**
 * 启动价格自动刷新定时器
 */
function startPriceAutoRefresh() {
    // 清除旧的定时器
    if (priceRefreshTimer) {
        clearInterval(priceRefreshTimer);
    }

    // 每30秒自动刷新一次价格
    priceRefreshTimer = setInterval(() => {
        refreshAllVaultPrices();
    }, PRICE_REFRESH_INTERVAL);

    console.log(`[价格刷新] 已启动自动刷新，每 ${PRICE_REFRESH_INTERVAL / 1000} 秒刷新一次`);
}

/**
 * 停止价格自动刷新定时器
 */
function stopPriceAutoRefresh() {
    if (priceRefreshTimer) {
        clearInterval(priceRefreshTimer);
        priceRefreshTimer = null;
        console.log('[价格刷新] 已停止自动刷新');
    }
}

// 页面卸载时清理定时器
window.addEventListener('beforeunload', () => {
    stopPriceAutoRefresh();
});

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

/**
 * 计算APY（年化收益率）
 * @param {string|number} totalDonations - 总捐赠数量
 * @param {string|number} totalDeposits - 总存款数量
 * @param {number} [blockNumber] - 金库创建时的区块号（可选，用于计算年化）
 * @param {number} [currentBlockNumber] - 当前区块号（可选）
 * @returns {string} 格式化的APY字符串，如 "12.34%"
 */
async function calculateAPY(totalDonations, totalDeposits, blockNumber = null, currentBlockNumber = null) {
    if (!totalDonations || !totalDeposits) return 'N/A';
    const donationsNum = parseFloat(totalDonations);
    const depositsNum = parseFloat(totalDeposits);
    if (isNaN(donationsNum) || isNaN(depositsNum) || depositsNum === 0) return '0.00%';
    
    // 计算当前收益率
    const currentYield = (donationsNum / depositsNum) * 100;
    
    // 如果没有区块号信息，直接返回当前收益率（不是年化）
    if (!blockNumber || !provider) {
        return currentYield.toFixed(2) + '%';
    }
    
    try {
        // 获取当前区块号（如果未提供）
        if (!currentBlockNumber) {
            currentBlockNumber = await provider.getBlockNumber();
        }
        
        // 获取创建区块和当前区块的时间戳
        const [creationBlock, currentBlock] = await Promise.all([
            provider.getBlock(blockNumber),
            provider.getBlock(currentBlockNumber)
        ]);
        
        if (!creationBlock || !currentBlock) {
            return currentYield.toFixed(2) + '%';
        }
        
        const creationTime = creationBlock.timestamp;
        const currentTime = currentBlock.timestamp;
        const elapsedSeconds = currentTime - creationTime;
        
        // 如果时间太短（少于1小时），不进行年化计算，避免极端值
        if (elapsedSeconds < 3600) {
            return currentYield.toFixed(2) + '%';
        }
        
        // 计算年化APY: (当前收益率 / 已过天数) * 365
        const elapsedDays = elapsedSeconds / 86400; // 转换为天数
        const apy = (currentYield / elapsedDays) * 365;
        
        return apy.toFixed(2) + '%';
    } catch (error) {
        console.warn('计算年化APY失败，返回当前收益率:', error);
        return currentYield.toFixed(2) + '%';
    }
}

/**
 * 同步版本的APY计算（用于不需要异步的场景，返回当前收益率）
 * @param {string|number} totalDonations - 总捐赠数量
 * @param {string|number} totalDeposits - 总存款数量
 * @returns {string} 格式化的收益率字符串，如 "12.34%"
 */
function calculateAPYSync(totalDonations, totalDeposits) {
    if (!totalDonations || !totalDeposits) return 'N/A';
    const donationsNum = parseFloat(totalDonations);
    const depositsNum = parseFloat(totalDeposits);
    if (isNaN(donationsNum) || isNaN(depositsNum) || depositsNum === 0) return '0.00%';
    const yieldRate = (donationsNum / depositsNum) * 100;
    return yieldRate.toFixed(2) + '%';
}

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
            return await this.factoryContract.getVaultsCount();
        } catch (e) {
            console.error('获取金库数量失败:', e);
            console.log('合约可用方法:', Object.keys(this.factoryContract.functions || {}));
            return 0;
        }
    }

    async getVaultAddress(index) {
        try {
            return await this.factoryContract.vaults(index);
        } catch (e) {
            console.error(`获取第 ${index} 个金库失败:`, e);
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

            // 获取代币小数位数
            const decimals = await getTokenDecimals(tokenAddress, this.provider);

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

            // 获取代币小数位数
            const decimals = await getTokenDecimals(tokenAddress, this.provider);
            const amountWei = parseTokenAmount(amount.toString(), decimals);

            // 记录存款前的余额
            const userBalanceBefore = await this.getTokenBalance(tokenAddress, userAddress);
            const vaultBalanceBefore = await this.getTokenBalance(tokenAddress, vaultAddress);

            console.log('📊 存款前余额:');
            console.log(`   用户: ${formatTokenAmount(userBalanceBefore, decimals)}`);
            console.log(`   金库: ${formatTokenAmount(vaultBalanceBefore, decimals)}`);

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
            console.log(`   用户: ${formatTokenAmount(userBalanceAfter, decimals)}`);
            console.log(`   金库: ${formatTokenAmount(vaultBalanceAfter, decimals)}`);
            console.log(`   用户变化: ${formatTokenAmount(userBalanceBefore.sub(userBalanceAfter), decimals)}`);
            console.log(`   金库变化: ${formatTokenAmount(vaultBalanceAfter.sub(vaultBalanceBefore), decimals)}`);

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

            // 获取代币小数位数
            const decimals = await getTokenDecimals(tokenAddress, this.provider);

            // 获取预期提现金额（手动计算 pendingReward）
            const userInfo = await vault.userInfo(userAddress);
            const accRewardPerShare = await vault.accRewardPerShare();
            const PRECISION = ethers.BigNumber.from('1000000000000'); // 1e12
            const pendingReward = userInfo.principal.mul(accRewardPerShare).div(PRECISION).sub(userInfo.rewardDebt);
            const expectedAmount = userInfo.principal.add(pendingReward);

            const userBalanceBefore = await this.getTokenBalance(tokenAddress, userAddress);
            const vaultBalanceBefore = await this.getTokenBalance(tokenAddress, vaultAddress);

            console.log('📊 提现前余额:');
            console.log(`   用户: ${formatTokenAmount(userBalanceBefore, decimals)}`);
            console.log(`   金库: ${formatTokenAmount(vaultBalanceBefore, decimals)}`);
            console.log(`   预期提现: ${formatTokenAmount(expectedAmount, decimals)} (本金 ${formatTokenAmount(userInfo.principal, decimals)} + 收益 ${formatTokenAmount(pendingReward, decimals)})`);

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
            console.log(`   用户变化: +${formatTokenAmount(userBalanceAfter.sub(userBalanceBefore), decimals)}`);
            console.log(`   金库变化: -${formatTokenAmount(vaultBalanceBefore.sub(vaultBalanceAfter), decimals)}`);

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

    // 创建金库（原子创建：创建 + 首笔存款）
    async createVault(tokenAddress, initialDeposit, vaultName, signer) {
        try {
            // 确保地址格式正确
            const checksumAddress = ethers.utils.getAddress(tokenAddress);
            const factory = this.factoryContract.connect(signer);

            if (!initialDeposit || initialDeposit.lte(0)) {
                throw new Error('初始存款数量必须 > 0');
            }

            // 先授权代币给工厂合约（由工厂转入金库）
            const tokenContract = new ethers.Contract(
                checksumAddress,
                ['function approve(address spender, uint256 amount) returns (bool)'],
                signer
            );
            const approveTx = await tokenContract.approve(this.factoryAddress, initialDeposit);
            await approveTx.wait();

            // 调用 createVault（原子创建 + 首笔存款），传入自定义名称（可为空字符串）
            const tx = await factory.createVault(checksumAddress, initialDeposit, vaultName || '');
            const receipt = await tx.wait();

            // 从 event 中提取新金库地址
            let vaultAddress = null;
            if (receipt && receipt.events) {
                const event = receipt.events.find(e => e.event === 'VaultCreated');
                if (event && event.args) {
                    vaultAddress = event.args.vaultAddress;
                }
            }

            return { tx, receipt, vaultAddress };
        } catch (e) {
            throw new Error(`创建金库失败: ${e.message}`);
        }
    }
}


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

        // 2. 保存到 localStorage
        localStorage.setItem('selectedNetwork', network);

        // 3. 重新初始化 provider
        provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl);
        console.log('✓ 已更新 RPC:', CONFIG.rpcUrl);

        // 4. 重新初始化管理器
        vaultManager = new VaultManager(VAULT_FACTORY_ADDRESS, provider);

        // 5. 如果已连接钱包，尝试切换钱包网络
        const walletProvider = getWalletProvider(false, true);
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

        // 6. 清除价格缓存（不同网络的价格数据不同）
        priceCache.clear();
        console.log('✓ 已清除价格缓存');

        // 7. 停止价格自动刷新（将在 loadAllVaults 后重新启动）
        stopPriceAutoRefresh();

        // 8. 更新 UI
        updateNetworkUI();

        // 9. 重新加载所有数据
        await loadAllVaults();

        // 10. 如果已连接钱包，重新加载用户数据
        if (walletAddress) {
            await loadUserVaults();
        }

        hideLoading();
        console.log(`✓ 网络切换完成: ${CONFIG.displayName}`);

        // 显示切换成功提示，然后刷新页面以确保所有状态正确重置
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
    const networkSelect = document.getElementById('networkSelect');

    if (networkSelect) {
        networkSelect.value = currentNetwork;
        // 更新下拉菜单的显示文本（通过更新选项）
        const options = networkSelect.querySelectorAll('option');
        options.forEach(opt => {
            if (opt.value === currentNetwork) {
                opt.selected = true;
            }
        });
    }
}

// ===== 初始化函数 =====
async function init() {
    try {
        // 1. 加载 ABI
        await loadABIs();

        // 2. 更新网络 UI
        updateNetworkUI();

        // 3. 初始化只读 provider：固定使用币安官方 RPC（不依赖钱包网络，解决 Binance 钱包问题）
        provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl);
        console.log('✓ 使用固定 RPC 进行只读操作:', CONFIG.rpcUrl);
        console.log('✓ 当前网络:', CONFIG.displayName);

        // 4. 初始化管理器（只读，始终用固定 RPC provider）
        vaultManager = new VaultManager(VAULT_FACTORY_ADDRESS, provider);

        const walletProvider = getWalletProvider(false, false);
        if (walletProvider) {
            console.log('当前域名:', window.location.origin);
            console.log('当前协议:', window.location.protocol);
        }

        // 5. 设置事件监听器
        setupEventListeners();

        // 6. 先加载所有金库数据（这样 connectWallet() 中的 loadUserVaults() 可以直接使用已加载的数据）
        await loadAllVaults();

        // 7. 尝试自动连接钱包（使用上面已声明的 walletProvider）
        if (walletProvider) {
            try {
                const accounts = await walletProvider.request({ method: 'eth_accounts' });
                if (accounts && accounts.length > 0) {
                    await connectWallet();
                }
            } catch (e) {
                console.warn('自动连接钱包失败:', e.message);
            }
        } else {
            console.warn('未检测到钱包，使用只读模式');
        }

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
        console.log('=== 开始连接钱包 ===');
        console.log('当前域名:', window.location.origin);
        console.log('当前协议:', window.location.protocol);

        // 检查钱包是否存在（静默模式，不重复打印日志）
        const walletProvider = getWalletProvider(false, true);
        if (!walletProvider) {
            showModal('未安装钱包', '请先安装钱包插件');
            return;
        }

        const accounts = await walletProvider.request({
            method: 'eth_requestAccounts'
        });
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

        // 网络切换后，更新 signer 和 provider
        // 如果网络正确，使用钱包 RPC（更快）；否则保持使用固定 RPC
        const web3Provider = new ethers.providers.Web3Provider(walletProvider, 'any');
        signer = web3Provider.getSigner();

        // 检查钱包网络是否匹配（如果不匹配，提示用户只能查看不能操作）
        // 注意：provider 保持不变，始终使用固定 RPC 做只读，解决 Binance 钱包问题
        try {
            const chainId = await walletProvider.request({ method: 'eth_chainId' });
            if (chainId !== CONFIG.chainId) {
                console.warn('⚠ 钱包网络不匹配，只能查看，不能进行链上操作');
                showModal('网络不匹配', `当前钱包网络与 ${CONFIG.displayName} 不匹配，您只能查看数据，无法进行存款、提现等操作。`);
            }
        } catch (e) {
            console.warn('检查钱包网络失败:', e);
        }

        updateUI();

        // 连接钱包后刷新“我的金库”（只读依然走 RPC）
        loadUserVaults();

    } catch (error) {
        console.error('连接钱包失败:', error);
        console.error('错误详情:', {
            message: error.message,
            code: error.code,
            stack: error.stack
        });

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

/**
 * 获取所有金库地址（公共函数，避免重复代码）
 * @param {number} maxLimit - 最大加载数量，默认100
 * @returns {Promise<string[]>} 金库地址数组
 */
async function getAllVaultAddresses(maxLimit = 100) {
    const factoryContract = new ethers.Contract(
        VAULT_FACTORY_ADDRESS,
        VAULT_FACTORY_ABI,
        provider
    );
    vaultManager.setFactoryContract(factoryContract);

    try {
        const addresses = await factoryContract.getVaults();
        console.log(`✓ 获取到 ${addresses.length} 个金库地址`);
        return addresses.slice(0, maxLimit);
    } catch (error) {
        console.warn('Factory.getVaults() 失败，回退到逐个获取:', error);
        const countBN = await vaultManager.getFactoryVaultCount();
        const count = parseInt(countBN.toString());
        const loadLimit = Math.min(count, maxLimit);
        const promises = [];
        for (let i = 0; i < loadLimit; i++) {
            promises.push(vaultManager.getVaultAddress(i).catch(() => null));
        }
        return (await Promise.all(promises)).filter(Boolean);
    }
}

/**
 * 将用户信息格式化为用户金库数据（公共函数，避免重复代码）
 * @param {Array} vaults - 包含 userInfo 的金库数组
 * @returns {Array} 格式化后的用户金库列表
 */
function formatUserVaults(vaults) {
    const PRECISION = ethers.BigNumber.from('1000000000000'); // 1e12

    return vaults
        .filter(vault => vault.userInfo && vault.userInfo.principal && vault.userInfo.principal.gt(0))
        .map(vault => {
            const decimals = vault.tokenDecimals || 18;
            const principal = vault.userInfo.principal;
            const rewardDebt = vault.userInfo.rewardDebt || ethers.BigNumber.from(0);
            const accRewardPerShare = vault.userInfo.accRewardPerShare || ethers.BigNumber.from(0);

            // 计算用户获得的捐赠：pendingReward = (principal * accRewardPerShare) / PRECISION - rewardDebt
            const pendingRewardRaw = principal.mul(accRewardPerShare).div(PRECISION).sub(rewardDebt);
            const pendingReward = formatTokenAmount(pendingRewardRaw, decimals);
            const totalAmount = parseFloat(formatTokenAmount(principal, decimals)) + parseFloat(pendingReward);

            return {
                address: vault.address,
                depositToken: vault.depositToken,
                depositAmount: formatTokenAmount(principal, decimals),
                pendingReward: pendingReward, // 获得的捐赠
                totalAmount: totalAmount.toString(), // 本金 + 获得的捐赠
                consensusReached: vault.consensusReached,
                tokenSymbol: vault.tokenSymbol,
                vaultName: vault.vaultName,
                displayName: vault.displayName
            };
        });
}

async function loadAllVaults() {
    try {
        if (!VAULT_FACTORY_ABI.length) return;

        console.log('🚀 使用 Multicall 批量加载金库...');
        const startTime = Date.now();

        // 1. 获取所有金库地址
        const vaultAddresses = await getAllVaultAddresses(100);

        if (vaultAddresses.length === 0) {
            allVaults = [];
            filteredVaults = [];
            currentPage = 0;
            loadMoreVaults();
            return;
        }

        // 2. 使用 Multicall 批量获取所有金库详情
        const multicallContract = new ethers.Contract(
            MULTICALL3_ADDRESS,
            MULTICALL3_ABI,
            provider
        );
        const vaultInterface = new ethers.utils.Interface(CONSENSUS_VAULT_ABI);

        const calls = [];
        const CALLS_PER_VAULT = 8;

        vaultAddresses.forEach(addr => {
            calls.push({ target: addr, callData: vaultInterface.encodeFunctionData('depositToken') });
            calls.push({ target: addr, callData: vaultInterface.encodeFunctionData('name') });
            calls.push({ target: addr, callData: vaultInterface.encodeFunctionData('totalPrincipal') });
            calls.push({ target: addr, callData: vaultInterface.encodeFunctionData('totalVoteWeight') });
            calls.push({ target: addr, callData: vaultInterface.encodeFunctionData('consensusReached') });
            calls.push({ target: addr, callData: vaultInterface.encodeFunctionData('unlockAt') });
            calls.push({ target: addr, callData: vaultInterface.encodeFunctionData('participantCount') });
            calls.push({ target: addr, callData: vaultInterface.encodeFunctionData('totalDonations') });
        });

        // 额外查询每个金库的合约余额（用于计算真实总市值）
        const tokenBalanceCalls = [];
        const tokenBalanceInterface = new ethers.utils.Interface([
            'function balanceOf(address) view returns (uint256)'
        ]);

        // 先获取所有金库的 depositToken 地址，然后查询余额
        // 注意：这里需要两轮查询，第一轮获取 depositToken，第二轮查询余额
        // 为了简化，我们在解码第一轮结果后再查询余额

        console.log(`📡 通过 Multicall 批量查询 ${vaultAddresses.length} 个金库的金库详情（${calls.length} 次调用）...`);
        const [blockNumber, returnData] = await multicallContract.callStatic.aggregate(calls);

        // 3. 解码金库数据
        const vaultDetails = [];
        const tokenAddresses = new Set();

        for (let i = 0; i < vaultAddresses.length; i++) {
            try {
                const baseIndex = i * CALLS_PER_VAULT;
                const depositToken = vaultInterface.decodeFunctionResult('depositToken()', returnData[baseIndex])[0];
                const name = vaultInterface.decodeFunctionResult('name()', returnData[baseIndex + 1])[0];
                const totalPrincipal = vaultInterface.decodeFunctionResult('totalPrincipal()', returnData[baseIndex + 2])[0];
                const totalVoteWeight = vaultInterface.decodeFunctionResult('totalVoteWeight()', returnData[baseIndex + 3])[0];
                const consensusReached = vaultInterface.decodeFunctionResult('consensusReached()', returnData[baseIndex + 4])[0];
                const unlockAt = vaultInterface.decodeFunctionResult('unlockAt()', returnData[baseIndex + 5])[0];
                const participantCount = vaultInterface.decodeFunctionResult('participantCount()', returnData[baseIndex + 6])[0];
                const totalDonations = vaultInterface.decodeFunctionResult('totalDonations()', returnData[baseIndex + 7])[0];

                vaultDetails.push({
                    address: vaultAddresses[i],
                    depositToken,
                    totalDeposits: totalPrincipal,
                    totalYesVotes: totalVoteWeight,
                    consensusReached,
                    unlockAt,
                    participantCount,
                    totalDonations,
                    vaultName: name,
                    blockNumber: i
                });

                if (depositToken && depositToken !== ethers.constants.AddressZero) {
                    tokenAddresses.add(depositToken);
                }
            } catch (err) {
                console.warn(`解码金库 ${vaultAddresses[i]} 数据失败:`, err);
            }
        }

        console.log(`✓ Multicall 查询完成，成功获取 ${vaultDetails.length} 个金库详情`);

        // 4. 批量查询每个金库的合约余额（用于计算真实总市值）
        const vaultBalanceMap = new Map();
        if (vaultDetails.length > 0) {
            const balanceCalls = [];
            const balanceInterface = new ethers.utils.Interface([
                'function balanceOf(address) view returns (uint256)'
            ]);

            vaultDetails.forEach(vault => {
                if (vault.depositToken && vault.depositToken !== ethers.constants.AddressZero) {
                    balanceCalls.push({
                        target: vault.depositToken,
                        callData: balanceInterface.encodeFunctionData('balanceOf', [vault.address])
                    });
                }
            });

            if (balanceCalls.length > 0) {
                try {
                    console.log(`📡 批量查询 ${balanceCalls.length} 个金库的合约余额...`);
                    const [, balanceReturnData] = await multicallContract.callStatic.aggregate(balanceCalls);

                    let balanceCallIndex = 0;
                    vaultDetails.forEach(vault => {
                        if (vault.depositToken && vault.depositToken !== ethers.constants.AddressZero) {
                            try {
                                const balanceResult = balanceInterface.decodeFunctionResult('balanceOf(address)', balanceReturnData[balanceCallIndex]);
                                vaultBalanceMap.set(vault.address, balanceResult[0]);
                                balanceCallIndex++;
                            } catch (err) {
                                console.warn(`解码金库 ${vault.address} 余额失败:`, err);
                                // 如果查询失败，使用 totalPrincipal 作为后备
                                vaultBalanceMap.set(vault.address, vault.totalDeposits);
                                balanceCallIndex++;
                            }
                        } else {
                            // 如果没有 depositToken，使用 totalPrincipal
                            vaultBalanceMap.set(vault.address, vault.totalDeposits);
                        }
                    });
                    console.log(`✓ 合约余额查询完成`);
                } catch (err) {
                    console.warn('批量查询合约余额失败，使用 totalPrincipal 作为后备:', err);
                    // 如果批量查询失败，使用 totalPrincipal 作为后备
                    vaultDetails.forEach(vault => {
                        vaultBalanceMap.set(vault.address, vault.totalDeposits);
                    });
                }
            }
        }

        // 5. 批量获取代币信息（symbol, decimals）
        const tokenInfoMap = new Map();
        if (tokenAddresses.size > 0) {
            const tokenCalls = [];
            const tokenAddressArray = Array.from(tokenAddresses);
            const tokenInterface = new ethers.utils.Interface([
                'function symbol() view returns (string)',
                'function decimals() view returns (uint8)'
            ]);

            tokenAddressArray.forEach(addr => {
                tokenCalls.push({
                    target: addr,
                    callData: tokenInterface.encodeFunctionData('symbol')
                });
                tokenCalls.push({
                    target: addr,
                    callData: tokenInterface.encodeFunctionData('decimals')
                });
            });

            try {
                // 使用 callStatic 来调用 aggregate，因为它是只读操作，不需要 signer
                const [, tokenReturnData] = await multicallContract.callStatic.aggregate(tokenCalls);

                // 解码代币信息
                for (let i = 0; i < tokenAddressArray.length; i++) {
                    const addr = tokenAddressArray[i];
                    try {
                        const symbolResult = tokenInterface.decodeFunctionResult('symbol()', tokenReturnData[i * 2]);
                        const decimalsResult = tokenInterface.decodeFunctionResult('decimals()', tokenReturnData[i * 2 + 1]);
                        // decodeFunctionResult 返回数组，取第一个元素
                        const symbol = symbolResult[0];
                        const decimals = parseInt(decimalsResult[0].toString());
                        tokenInfoMap.set(addr, {
                            symbol: symbol,
                            decimals: decimals
                        });
                    } catch (err) {
                        console.warn(`解码代币 ${addr} 信息失败:`, err);
                        tokenInfoMap.set(addr, { symbol: 'TOKEN', decimals: 18 });
                    }
                }
            } catch (err) {
                console.warn('批量获取代币信息失败，使用默认值:', err);
                tokenAddressArray.forEach(addr => {
                    tokenInfoMap.set(addr, { symbol: 'TOKEN', decimals: 18 });
                });
            }
        }

        // 6. 格式化并组装最终数据
        allVaults = vaultDetails.map(vault => {
            const tokenInfo = tokenInfoMap.get(vault.depositToken) || { symbol: 'TOKEN', decimals: 18 };
            const decimals = tokenInfo.decimals;
            const contractBalance = vaultBalanceMap.get(vault.address) || vault.totalDeposits;

            return {
                address: vault.address,
                depositToken: vault.depositToken,
                totalDeposits: vault.totalDeposits,
                contractBalance: contractBalance, // 合约实际余额（包含捐赠）
                totalYesVotes: vault.totalYesVotes,
                totalDonations: vault.totalDonations,
                consensusReached: vault.consensusReached,
                unlockAt: vault.unlockAt,
                participantCount: vault.participantCount,
                vaultName: vault.vaultName || '',
                tokenSymbol: tokenInfo.symbol,
                tokenDecimals: decimals,
                blockNumber: vault.blockNumber,
                totalDepositsFormatted: formatTokenAmount(vault.totalDeposits, decimals),
                contractBalanceFormatted: formatTokenAmount(contractBalance, decimals), // 用于计算总市值
                totalYesVotesFormatted: formatTokenAmount(vault.totalYesVotes, decimals),
                totalDonationsFormatted: formatTokenAmount(vault.totalDonations, decimals), // 累计获得的捐赠
                displayName: vault.vaultName && vault.vaultName.trim()
                    ? `${vault.vaultName} ${tokenInfo.symbol}`
                    : tokenInfo.symbol
            };
        });

        const loadTime = Date.now() - startTime;
        console.log(`✓ Multicall 加载完成，共 ${allVaults.length} 个金库，耗时 ${loadTime}ms`);

        // 6. 异步批量获取代币价格（不阻塞主流程，提升首屏速度）
        const uniqueTokenAddresses = [...new Set(allVaults.map(v => v.depositToken).filter(Boolean))];
        if (uniqueTokenAddresses.length > 0) {
            console.log(`开始异步批量获取 ${uniqueTokenAddresses.length} 个代币的价格...`);
            // 异步执行，不阻塞渲染
            getTokenPricesBatch(uniqueTokenAddresses).then(priceMap => {
                let successCount = 0;
                let failCount = 0;

                allVaults.forEach(vault => {
                    if (vault.depositToken && priceMap.has(vault.depositToken)) {
                        vault.priceData = priceMap.get(vault.depositToken);
                        if (vault.priceData) {
                            successCount++;
                            // 更新页面上已渲染的金库卡片
                            const valueEl = document.getElementById(`vault-total-value-${vault.address}`);
                            if (valueEl) {
                                const totalValue = calculateTotalValue(vault.contractBalanceFormatted || vault.totalDepositsFormatted, vault.priceData.price);
                                const valueSpan = valueEl.querySelector('.value');
                                if (valueSpan) {
                                    valueSpan.textContent = totalValue;
                                    valueSpan.classList.remove('price-loading');
                                }
                            }
                        } else {
                            failCount++;
                            console.warn(`[初始化价格] 代币 ${vault.depositToken} 的价格获取为空`);
                        }
                    }
                });
                console.log(`✓ 价格加载完成 (成功: ${successCount}, 失败: ${failCount})`);
            }).catch(err => {
                console.warn('价格加载失败:', err);
            });
        }

        // 启动价格自动刷新（每30秒刷新一次）
        startPriceAutoRefresh();

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

    if (!allVaults || allVaults.length === 0) {
        await loadAllVaults();
    }

    try {
        console.log('🚀 使用 Multicall 批量加载用户参与的金库...');
        const startTime = Date.now();

        const vaultAddresses = allVaults.map(v => v.address);
        if (vaultAddresses.length === 0) {
            userCache.participatedVaults = [];
            renderUserVaults();
            return;
        }

        const multicallContract = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
        const vaultInterface = new ethers.utils.Interface(CONSENSUS_VAULT_ABI);

        // 同时查询 userInfo 和 accRewardPerShare（用于计算用户获得的捐赠）
        const calls = [];
        vaultAddresses.forEach(addr => {
            calls.push({
                target: addr,
                callData: vaultInterface.encodeFunctionData('userInfo', [walletAddress])
            });
            calls.push({
                target: addr,
                callData: vaultInterface.encodeFunctionData('accRewardPerShare')
            });
        });

        console.log(`📡 通过 Multicall 批量查询 ${vaultAddresses.length} 个金库的用户信息和累积分红...`);
        const [, returnData] = await multicallContract.callStatic.aggregate(calls);

        // 解码用户信息和累积分红，并附加到 allVaults
        for (let i = 0; i < vaultAddresses.length; i++) {
            try {
                const userInfoResult = vaultInterface.decodeFunctionResult('userInfo(address)', returnData[i * 2]);
                const accRewardPerShare = vaultInterface.decodeFunctionResult('accRewardPerShare()', returnData[i * 2 + 1])[0];
                allVaults[i].userInfo = {
                    principal: userInfoResult[0],
                    rewardDebt: userInfoResult[1],
                    hasVoted: userInfoResult[2],
                    accRewardPerShare: accRewardPerShare
                };
            } catch (err) {
                console.warn(`解码用户信息失败 ${vaultAddresses[i]}:`, err);
                allVaults[i].userInfo = undefined;
            }
        }

        // 格式化用户金库列表
        userCache.participatedVaults = formatUserVaults(allVaults);

        const loadTime = Date.now() - startTime;
        console.log(`✓ Multicall 用户金库加载完成，共 ${userCache.participatedVaults.length} 个，耗时 ${loadTime}ms`);

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
        // 格式化显示名称：金库名字 + 代币symbol
        const fullDisplayTitle = vault.vaultName && vault.vaultName.trim()
            ? `${vault.vaultName} ${vault.tokenSymbol || 'TOKEN'}`
            : (vault.displayName || vault.tokenSymbol || 'TOKEN');

        // 限制显示长度（30个字符），超出部分用省略号
        const MAX_DISPLAY_LENGTH = 30;
        const isTruncated = fullDisplayTitle.length > MAX_DISPLAY_LENGTH;
        const displayTitle = isTruncated
            ? fullDisplayTitle.substring(0, MAX_DISPLAY_LENGTH) + '...'
            : fullDisplayTitle;

        card.innerHTML = `
            <div class="card-header">
                <h3${isTruncated ? ` title="${fullDisplayTitle}"` : ''}>${displayTitle}</h3>
                <span class="status-badge ${statusClass}"><i class="fas ${statusIcon}"></i> ${status}</span>
            </div>
            <div class="card-body">
                <div class="info-row">
                    <span class="label">我的存款</span>
                    <span class="value">${parseFloat(vault.depositAmount).toFixed(4)} ${vault.tokenSymbol || 'TOKEN'}</span>
                </div>
                <div class="info-row">
                    <span class="label">我获得的捐赠</span>
                    <span class="value">${parseFloat(vault.pendingReward || '0').toFixed(4)} ${vault.tokenSymbol || 'TOKEN'}</span>
                </div>
                <div class="info-row" id="user-vault-value-${vault.address}">
                    <span class="label">持仓市值</span>
                    <span class="value price-loading">加载中...</span>
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

        // 异步加载价格并更新持仓市值（优先使用已加载的价格数据）
        if (vault.depositToken) {
            // 先检查是否已经有价格数据（从 allVaults 中获取）
            const allVault = allVaults.find(v => v.address === vault.address);
            // 持仓市值 = 本金 + 获得的捐赠
            const totalAmount = vault.totalAmount || vault.depositAmount;
            if (allVault && allVault.priceData) {
                const userValue = calculateTotalValue(totalAmount, allVault.priceData.price);
                const valueEl = document.getElementById(`user-vault-value-${vault.address}`);
                if (valueEl) {
                    valueEl.querySelector('.value').textContent = userValue;
                    valueEl.querySelector('.value').classList.remove('price-loading');
                }
            } else {
                // 如果没有，再单独请求（延迟 3 秒，等待批量加载）
                setTimeout(() => {
                    // 再次检查（批量加载可能已完成）
                    const allVault = allVaults.find(v => v.address === vault.address);
                    if (allVault && allVault.priceData) {
                        const userValue = calculateTotalValue(totalAmount, allVault.priceData.price);
                        const valueEl = document.getElementById(`user-vault-value-${vault.address}`);
                        if (valueEl) {
                            valueEl.querySelector('.value').textContent = userValue;
                            valueEl.querySelector('.value').classList.remove('price-loading');
                        }
                        return;
                    }

                    // 如果还没有，再单独请求（作为兜底）
                    getTokenPrice(vault.depositToken).then(priceData => {
                        const valueEl = document.getElementById(`user-vault-value-${vault.address}`);
                        if (valueEl && priceData) {
                            // 同时更新 allVaults 中的价格数据
                            if (allVault) {
                                allVault.priceData = priceData;
                            }
                            const userValue = calculateTotalValue(totalAmount, priceData.price);
                            valueEl.querySelector('.value').textContent = userValue;
                            valueEl.querySelector('.value').classList.remove('price-loading');
                        } else if (valueEl) {
                            valueEl.querySelector('.value').textContent = 'N/A';
                            valueEl.querySelector('.value').classList.remove('price-loading');
                        }
                    }).catch(err => {
                        const valueEl = document.getElementById(`user-vault-value-${vault.address}`);
                        if (valueEl) {
                            valueEl.querySelector('.value').textContent = 'N/A';
                            valueEl.querySelector('.value').classList.remove('price-loading');
                        }
                    });
                }, 3000);
            }
        }

        grid.appendChild(card);
    });

    // 同步卡片头部高度，确保对齐
    setTimeout(() => {
        syncCardHeaderHeights();
    }, 100); // 延迟执行，确保DOM已更新

    // 渲染完成后立即刷新价格（不要等30秒）
    console.log('[我的金库] 渲染完成，立即刷新价格...');
    refreshAllVaultPrices().catch(err => {
        console.warn('[我的金库] 立即刷新价格失败:', err);
    });
}

function setupEventListeners() {
    const connectBtn = document.getElementById('connectButton');
    const navTabs = document.querySelectorAll('.tab');
    const createVaultBtn = document.getElementById('createVaultBtn');
    const filterType = document.getElementById('filterType');
    const sortOrder = document.getElementById('sortOrder');
    const modalClose = document.querySelector('.modal-close');
    const networkSelect = document.getElementById('networkSelect');

    // 网络切换下拉菜单
    if (networkSelect) {
        networkSelect.addEventListener('change', async (e) => {
            const selectedNetwork = e.target.value;
            if (selectedNetwork !== currentNetwork) {
                await switchNetwork(selectedNetwork);
            }
        });
    }

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
            const vaultName = document.getElementById('createVaultNameInput')?.value.trim() || '';
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
                // 先获取代币小数位数
                const tokenContract = new ethers.Contract(
                    tokenAddr,
                    ['function decimals() view returns (uint8)', 'function balanceOf(address owner) view returns (uint256)'],
                    provider
                );
                const decimals = await tokenContract.decimals();

                // 计算需要的初始存款数量（使用正确的小数位数）
                const depositWei = parseTokenAmount(depositAmount, decimals);

                // 在创建金库前，先检查代币余额是否足够，避免链上直接报 Insufficient balance
                try {
                    const userBalance = await tokenContract.balanceOf(walletAddress);
                    console.log('创建金库前余额检查: 余额 =', formatTokenAmount(userBalance, decimals), '需要 =', formatTokenAmount(depositWei, decimals));

                    if (userBalance.lt(depositWei)) {
                        showModal(
                            '余额不足',
                            `您的代币余额只有 ${formatTokenAmount(userBalance, decimals)}，不足以作为初始存款 ${depositAmount}`
                        );
                        return;
                    }
                } catch (balanceError) {
                    console.warn('检查代币余额失败，继续尝试创建金库:', balanceError);
                }

                showLoading('创建金库中，请在钱包确认交易...');
                const result = await vaultManager.createVault(tokenAddr, depositWei, vaultName, signer);

                hideLoading();

                // 验证金库地址是否有效
                if (!result.vaultAddress || result.vaultAddress === ethers.constants.AddressZero) {
                    throw new Error('创建金库失败：未获取到有效的金库地址');
                }

                // 获取代币符号用于分享
                let tokenSymbol = 'TOKEN';
                try {
                    const tokenContractForSymbol = new ethers.Contract(
                        tokenAddr,
                        ['function symbol() view returns (string)'],
                        provider
                    );
                    tokenSymbol = await tokenContractForSymbol.symbol();
                } catch (e) {
                    console.warn('获取代币符号失败:', e);
                }

                // 生成显示名称
                const displayName = vaultName && vaultName.trim() ? `${vaultName} ${tokenSymbol}` : tokenSymbol;
                const vaultUrl = `${window.location.origin}/vault.html?vault=${result.vaultAddress}`;

                // 检查用户输入的金库名称是否包含彩蛋关键词
                console.log('检查彩蛋 - vaultName:', vaultName);
                const hasEasterEgg = vaultName && vaultName.toLowerCase().includes("welcome to the jungle");

                if (hasEasterEgg) {
                    console.log('彩蛋触发！');
                    const successMessage = `金库已创建！ 🎉 Easter Egg! Congratulations 🎉 You've discovered the Easter egg! You're gonna die!`;
                    // 彩蛋：用户手动关闭弹窗后再跳转（不自动关闭）
                    showCreateSuccessModal('创建成功', successMessage, displayName, depositAmount, tokenSymbol, result.tx.hash, vaultUrl, result.vaultAddress, true);
                } else {
                    console.log('彩蛋未触发 - vaultName 不包含关键词');
                    showCreateSuccessModal('创建成功', `金库已创建！`, displayName, depositAmount, tokenSymbol, result.tx.hash, vaultUrl, result.vaultAddress, false);
                }

                // 清空输入框
                document.getElementById('createVaultNameInput').value = '';
                document.getElementById('createTokenInput').value = '';
                document.getElementById('createDepositInput').value = '';
            } catch (error) {
                hideLoading();
                console.error('创建金库失败:', error);

                // 解析具体错误信息
                let errorMessage = '创建金库时发生错误';
                if (error.message) {
                    if (error.message.includes('user rejected') || error.message.includes('User denied')) {
                        errorMessage = '您取消了交易';
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

    // 钱包事件监听（账户/网络切换）（静默模式，不重复打印日志）
    const walletProvider = getWalletProvider(false, true);
    if (walletProvider) {
        // 清理旧的监听器（如果钱包实现了 removeAllListeners）
        if (typeof walletProvider.removeAllListeners === 'function') {
            try {
                walletProvider.removeAllListeners('accountsChanged');
                walletProvider.removeAllListeners('chainChanged');
            } catch (e) {
                console.warn('移除钱包事件监听器失败:', e);
            }
        }

        // 账户切换时，自动更新全局地址和按钮显示
        walletProvider.on('accountsChanged', (accounts) => {
            console.log('账户已切换:', accounts);
            if (!accounts || accounts.length === 0) {
                walletAddress = null;
                signer = null;
                userCache.participatedVaults = [];
                updateUI();
                renderUserVaults();
            } else {
                // 重新连接钱包（只更新 signer，不改变 provider）
                walletAddress = accounts[0];
                const web3Provider = new ethers.providers.Web3Provider(walletProvider, 'any');
                signer = web3Provider.getSigner();
                updateUI();
                // 刷新"我的金库"列表（只读依然走固定 RPC）
                loadUserVaults();
            }
        });

        // 网络切换时，检查是否需要更新配置
        walletProvider.on('chainChanged', async (chainId) => {
            console.log('钱包网络已切换:', chainId);
            // 检查是否匹配当前配置的网络
            if (chainId !== CONFIG.chainId) {
                console.warn('⚠ 钱包网络与当前配置不匹配');
                // 不自动切换，让用户手动选择
                // 如果用户想切换，可以通过下拉菜单切换
            } else {
                // 网络匹配，更新 signer
                const web3Provider = new ethers.providers.Web3Provider(walletProvider, 'any');
                signer = web3Provider.getSigner();
                console.log('✓ 钱包网络已匹配当前配置');
            }
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

function showEasterEgg() {
    console.log('显示彩蛋消息');
    const message = "Congratulations 🎉 You've discovered the Easter egg! You're gonna die!";
    showModal('🎉 Easter Egg!', message);
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

        // 手动关闭按钮 - 支持点击和触摸事件（移动端兼容）
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

        // 点击背景关闭
        const handleOverlayClick = (e) => {
            if (e.target === overlay) closeModal();
        };
        overlay.removeEventListener('click', handleOverlayClick);
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
 * 分享到 X（Twitter）
 * @param {string} text
 * @param {string} [url]
 */
function shareToTwitter(text, url) {
    const TWITTER_INTENT = 'https://twitter.com/intent/tweet';
    const TWITTER_MAX_LEN = 280;
    const u = new URL(TWITTER_INTENT);
    u.searchParams.set('text', (text || '').slice(0, TWITTER_MAX_LEN));
    if (url) u.searchParams.set('url', url);
    window.open(u.toString(), '_blank', 'noopener,noreferrer');
}

// ===== 留言功能（localStorage） =====
const COMMENTS_STORAGE_KEY = 'consensusvault_comments';

/**
 * 规范化金库地址为存储 key（小写）
 * @param {string} vaultAddr
 * @returns {string}
 */
function commentsKey(vaultAddr) {
    if (!vaultAddr || typeof vaultAddr !== 'string') return '';
    return vaultAddr.toLowerCase();
}

/**
 * 从 localStorage 读取全量留言数据
 * @returns {Object.<string, Array>}
 */
function loadAllComments() {
    try {
        const raw = localStorage.getItem(COMMENTS_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (e) {
        console.warn('[留言] 读取失败:', e);
        return {};
    }
}

/**
 * 持久化全量留言数据到 localStorage
 * @param {Object.<string, Array>} data
 */
function saveAllComments(data) {
    try {
        localStorage.setItem(COMMENTS_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('[留言] 存储失败:', e);
    }
}

/**
 * 保存一条留言到指定金库
 * @param {string} vaultAddr
 * @param {string} userAddress
 * @param {string} action - 'create' | 'deposit' | 'vote' | 'donate' | 'withdraw'
 * @param {string} message
 * @param {string} [txHash]
 */
function saveComment(vaultAddr, userAddress, action, message, txHash) {
    const key = commentsKey(vaultAddr);
    if (!key) return;
    const all = loadAllComments();
    if (!Array.isArray(all[key])) all[key] = [];
    const entry = {
        timestamp: Date.now(),
        userAddress: userAddress || '',
        action: action || '',
        message: (message || '').trim(),
        txHash: txHash || ''
    };
    all[key].push(entry);
    saveAllComments(all);
}

/**
 * 生成创建金库的默认分享/留言内容
 * @param {string} displayName - 金库显示名称
 * @param {string} depositAmount - 初始存款金额
 * @param {string} tokenSymbol - 代币符号
 * @param {string} txHash - 交易哈希
 * @param {string} vaultUrl - 金库链接
 * @returns {string}
 */
function generateCreateVaultDefaultText(displayName, depositAmount, tokenSymbol, txHash, vaultUrl) {
    return `我刚在@Consensus_Vault\n<${displayName}> 金库\n创建了新的共识金库：${displayName}\n初始存款：${depositAmount} ${tokenSymbol}\n链上哈希：${txHash}`;
}

/**
 * 显示创建金库成功弹窗（带留言和分享功能）
 * @param {string} title
 * @param {string} message
 * @param {string} displayName - 金库显示名称
 * @param {string} depositAmount - 初始存款金额
 * @param {string} tokenSymbol - 代币符号
 * @param {string} txHash - 交易哈希
 * @param {string} vaultUrl - 金库链接
 * @param {string} vaultAddress - 金库地址
 * @param {boolean} isEasterEgg - 是否为彩蛋模式（不自动跳转）
 */
function showCreateSuccessModal(title, message, displayName, depositAmount, tokenSymbol, txHash, vaultUrl, vaultAddress, isEasterEgg) {
    // 生成默认内容
    const defaultText = generateCreateVaultDefaultText(displayName, depositAmount, tokenSymbol, txHash, vaultUrl);

    const safe = (message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const html = `
        <p class="modal-success-message">${safe}</p>
        <div class="modal-share-input-area">
            <label for="modalShareInput" style="display: block; margin-bottom: 8px; font-size: 13px; color: var(--text-muted);">编辑分享内容：</label>
            <textarea id="modalShareInput" class="modal-share-input" rows="4" maxlength="200" placeholder="编辑分享内容...">${defaultText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
            <div class="modal-share-char-count">
                <span id="modalShareCharCount">${defaultText.length}/500</span>
            </div>
        </div>
        <div class="modal-success-actions">
            <button type="button" id="modalBtnComment" class="btn btn-primary"><i class="fas fa-comment"></i> 留言</button>
            <button type="button" id="modalBtnShare" class="btn btn-primary"><i class="fab fa-x-twitter"></i> 分享到 X</button>
            <button type="button" id="modalBtnView" class="btn btn-primary"><i class="fas fa-eye"></i> 查看金库</button>
        </div>`;

    let hasClickedComment = false;
    let modalInput = null;

    // 保存留言（长文案，用输入框内容）
    const saveCommentLong = () => {
        if (!vaultAddress || !walletAddress || hasClickedComment) return;
        let text = (modalInput?.value || '').trim() || defaultText;
        if (!text) return;
        
        // 截断到200个字符（与链上合约限制保持一致）
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
        
        saveComment(vaultAddress, walletAddress, 'create', text, txHash);
        hasClickedComment = true;
    };

    // 仅关闭时保存的短文案（如 "创建金库 1000 USDT"）
    const saveCommentShortOnClose = () => {
        if (!vaultAddress || !walletAddress || hasClickedComment) return;
        const shortText = tokenSymbol ? `创建金库 ${depositAmount} ${tokenSymbol}` : `创建金库 ${depositAmount}`;
        saveComment(vaultAddress, walletAddress, 'create', shortText, txHash);
    };

    showModal(title, '', {
        htmlBody: html,
        onRender(bodyEl, closeModal) {
            const input = bodyEl.querySelector('#modalShareInput');
            const charCount = bodyEl.querySelector('#modalShareCharCount');
            const btnComment = bodyEl.querySelector('#modalBtnComment');
            const btnShare = bodyEl.querySelector('#modalBtnShare');
            const btnView = bodyEl.querySelector('#modalBtnView');

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
                btnComment.addEventListener('click', () => {
                    saveCommentLong();
                    disableBtn(btnComment);
                });
                btnComment.addEventListener('touchend', (e) => { e.preventDefault(); btnComment.click(); });
            }

            // 分享：只分享，不关弹窗；文案已含金库地址，不传 url 避免重复；仅分享按钮变灰失效
            if (btnShare) {
                btnShare.addEventListener('click', () => {
                    const text = (input?.value || '').trim() || defaultText;
                    shareToTwitter(text);
                    disableBtn(btnShare);
                });
                btnShare.addEventListener('touchend', (e) => { e.preventDefault(); btnShare.click(); });
            }

            // 查看金库：关闭弹窗并跳转
            if (btnView) {
                btnView.addEventListener('click', () => {
                    closeModal();
                    goToVaultDetail(vaultAddress);
                });
                btnView.addEventListener('touchend', (e) => { e.preventDefault(); btnView.click(); });
            }
        }
    }).then(() => {
        // 仅当用户直接关闭弹窗（未点留言）时，保存短文案如 "创建金库 1000 USDT"
        saveCommentShortOnClose();
        // 如果是彩蛋模式，关闭后跳转；否则已经在2秒后自动跳转了
        if (isEasterEgg) {
            goToVaultDetail(vaultAddress);
        }
    });

    // 非彩蛋模式：2秒后自动跳转
    if (!isEasterEgg) {
        setTimeout(() => {
            goToVaultDetail(vaultAddress);
        }, 2000);
    }
}


// 当同一代币存在多个未解锁金库时，弹出选择列表
function showVaultSelectionModal(activeVaults, tokenSymbol = 'TOKEN') {
    const overlay = document.getElementById('modalOverlay');
    if (!overlay) return;

    const titleEl = overlay.querySelector('.modal-title');
    const bodyEl = overlay.querySelector('.modal-body');

    if (titleEl) {
        titleEl.textContent = `${tokenSymbol} 有多个活跃金库`;
    }

    if (bodyEl) {
        const itemsHtml = activeVaults
            .sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0)) // 最新一期排在最上面
            .map(vault => {
                const totalDeposits = parseFloat(vault.totalDepositsFormatted || '0');
                const totalYesVotes = parseFloat(vault.totalYesVotesFormatted || '0');
                const progress = vault.consensusReached
                    ? 100
                    : (totalDeposits > 0 ? (totalYesVotes / totalDeposits * 100) : 0);
                const shortAddr = `${vault.address.slice(0, 8)}...${vault.address.slice(-6)}`;

                // 调试信息
                console.log('金库选择弹窗 - 金库数据:', {
                    address: vault.address,
                    vaultName: vault.vaultName,
                    tokenSymbol: vault.tokenSymbol
                });

                // 显示名称：金库名字 + 代币symbol，如果没有名字就只显示symbol
                const displayTitle = vault.vaultName && vault.vaultName.trim()
                    ? `${vault.vaultName} ${vault.tokenSymbol || tokenSymbol}`
                    : (vault.tokenSymbol || tokenSymbol);

                return `
                    <div class="vault-select-item" style="margin-bottom: 12px; padding: 10px; border-radius: 6px; background: #f8f9fb;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <div style="font-weight:700; color:#1a1a1a; font-size:15px;">${displayTitle}</div>
                            <div style="font-size:12px; color:#666;">共识进度：${progress.toFixed(1)}%</div>
                        </div>
                        <div style="font-size:12px; color:#888; margin-bottom:6px;">金库地址：${shortAddr}</div>
                        <button class="btn btn-small vault-select-btn" data-address="${vault.address}">
                            <i class="fas fa-arrow-right"></i> 进入此金库
                        </button>
                    </div>
                `;
            })
            .join('');

        bodyEl.innerHTML = `
            <p style="margin-bottom:10px; font-size:13px; color:#555;">
                该代币当前有多个未解锁金库，请选择要进入的金库：
            </p>
            ${itemsHtml}
        `;
    }

    overlay.style.display = 'flex'; // 使用 flex 确保正确显示

    // 关闭模态框的函数
    const closeModal = () => {
        overlay.style.display = 'none';
    };

    // 手动关闭按钮 - 支持点击和触摸事件（移动端兼容）
    const closeBtn = overlay.querySelector('.modal-close');
    if (closeBtn) {
        // 移除旧的事件监听器，添加新的
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);

        // 同时支持点击和触摸事件（移动端兼容）
        newCloseBtn.addEventListener('click', closeModal);
        newCloseBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            closeModal();
        });
    }

    // 点击背景关闭 - 支持点击和触摸事件（移动端兼容）
    const handleOverlayClick = (e) => {
        if (e.target === overlay) {
            closeModal();
        }
    };

    // 移除旧的事件监听器
    overlay.removeEventListener('click', handleOverlayClick);
    overlay.removeEventListener('touchend', handleOverlayClick);

    // 添加新的事件监听器
    overlay.addEventListener('click', handleOverlayClick);
    overlay.addEventListener('touchend', (e) => {
        if (e.target === overlay) {
            e.preventDefault();
            closeModal();
        }
    });

    // 绑定每个按钮的点击事件
    const buttons = overlay.querySelectorAll('.vault-select-btn');
    buttons.forEach(btn => {
        // 移除旧的事件监听器
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        // 添加点击和触摸事件
        newBtn.addEventListener('click', () => {
            const addr = newBtn.getAttribute('data-address');
            if (addr) {
                closeModal();
                goToVaultDetail(addr);
            }
        });
        newBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            const addr = newBtn.getAttribute('data-address');
            if (addr) {
                closeModal();
                goToVaultDetail(addr);
            }
        });
    });
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

    // 诊断时强制刷新并显示日志
    const walletProvider = getWalletProvider(true, false);
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

/**
 * 诊断代币价格问题
 */
async function diagnosticTokenPrices() {
    console.log('=== 代币价格诊断 ===');

    if (!allVaults || allVaults.length === 0) {
        console.warn('未加载任何金库');
        return;
    }

    const uniqueTokenAddresses = [...new Set(allVaults.map(v => v.depositToken).filter(Boolean))];
    console.log(`检测到 ${uniqueTokenAddresses.length} 个代币需要查询价格`);
    console.log('代币地址列表:');
    uniqueTokenAddresses.forEach((addr, i) => {
        console.log(`  ${i + 1}. ${typeof addr === 'string' ? addr : addr.toString()}`);
    });

    console.log('\n--- 测试 API 连接 ---');
    for (const tokenAddress of uniqueTokenAddresses.slice(0, 2)) { // 测试前2个
        const normalizedAddress = typeof tokenAddress === 'string' ? tokenAddress : tokenAddress.toString();
        console.log(`\n测试代币: ${normalizedAddress}`);
        const url = `https://api.dexscreener.com/token-pairs/v1/bsc/${normalizedAddress}`;
        console.log(`URL: ${url}`);
        try {
            const response = await fetch(url);
            console.log(`状态码: ${response.status}`);
            const data = await response.json();
            console.log('完整响应:', JSON.stringify(data, null, 2));
            console.log('API 响应:', {
                pairsCount: data.pairs?.length || 0,
                dataKeys: Object.keys(data),
                pairs: data.pairs?.map(p => ({
                    base: p.baseToken?.symbol,
                    quote: p.quoteToken?.symbol,
                    price: p.priceUsd,
                    liquidity: p.liquidity?.usd,
                    txns24h: p.txns?.h24
                }))
            });
        } catch (err) {
            console.error('API 请求失败:', err);
        }
    }

    console.log('\n--- 当前金库价格状态 ---');
    allVaults.forEach(vault => {
        console.log(`${vault.vaultName}:`, {
            depositToken: typeof vault.depositToken === 'string' ? vault.depositToken : vault.depositToken.toString(),
            price: vault.priceData?.price,
            change24h: vault.priceData?.change24h,
            totalValue: vault.totalValue
        });
    });

    console.log('\n--- 缓存状态 ---');
    console.log('缓存条目数:', priceCache.size);
    if (priceCache.size > 0) {
        priceCache.forEach((value, key) => {
            console.log(`${key.substring(0, 10)}...: $${value.data?.price} (${new Date(value.timestamp).toLocaleTimeString()})`);
        });
    }
}

// ===== 页面加载 =====
window.addEventListener('load', () => {
    // 执行诊断
    diagnoseWalletConnection();
    init();
});

// ===== 全局函数导出 =====
window.switchView = switchView;
window.connectWallet = connectWallet;
window.goToVaultDetail = goToVaultDetail;
window.diagnosticTokenPrices = diagnosticTokenPrices;

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

        case 'marketValue':
            // 按总市值倒序（需要价格数据）
            sorted.sort((a, b) => {
                const getMarketValue = (v) => {
                    if (!v.priceData || !(v.contractBalanceFormatted || v.totalDepositsFormatted)) return 0;
                    const amt = parseFloat(v.contractBalanceFormatted || v.totalDepositsFormatted) || 0;
                    return amt * v.priceData.price;
                };
                const valueA = getMarketValue(a);
                const valueB = getMarketValue(b);
                if (valueA > 0 && valueB > 0) return valueB - valueA;
                if (valueA > 0) return -1;
                if (valueB > 0) return 1;
                return (b.blockNumber || 0) - (a.blockNumber || 0);
            });
            break;

        case 'participantCount':
            // 按参与人数倒序
            sorted.sort((a, b) => {
                const pa = Number(a.participantCount?.toString?.() ?? 0);
                const pb = Number(b.participantCount?.toString?.() ?? 0);
                return pb - pa;
            });
            break;

        case 'donations':
            // 按获得的捐赠倒序
            sorted.sort((a, b) => {
                const da = parseFloat(a.totalDonationsFormatted || '0') || 0;
                const db = parseFloat(b.totalDonationsFormatted || '0') || 0;
                return db - da;
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

    // 同步卡片头部高度，确保对齐
    setTimeout(() => {
        syncCardHeaderHeights();
    }, 100); // 延迟执行，确保DOM已更新

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

    // 格式化显示名称：金库名字 + 代币symbol
    const fullDisplayTitle = vault.vaultName && vault.vaultName.trim()
        ? `${vault.vaultName} ${vault.tokenSymbol || 'TOKEN'}`
        : (vault.tokenSymbol || 'VAULT');

    // 限制显示长度（30个字符），超出部分用省略号
    const MAX_DISPLAY_LENGTH = 30;
    const isTruncated = fullDisplayTitle.length > MAX_DISPLAY_LENGTH;
    const displayTitle = isTruncated
        ? fullDisplayTitle.substring(0, MAX_DISPLAY_LENGTH) + '...'
        : fullDisplayTitle;

    div.innerHTML = `
        <div class="card-header">
            <h3${isTruncated ? ` title="${fullDisplayTitle}"` : ''}>${displayTitle}</h3>
            <span class="status-badge ${statusClass}">${status}</span>
        </div>
        <div class="card-body">
            <div class="info-row">
                <span class="label">总存款</span>
                <span class="value">${parseFloat(vault.totalDepositsFormatted).toFixed(4)} ${vault.tokenSymbol || 'TOKEN'}</span>
            </div>
            <div class="info-row">
                <span class="label">获得的捐赠</span>
                <span class="value">${parseFloat(vault.totalDonationsFormatted || '0').toFixed(4)} ${vault.tokenSymbol || 'TOKEN'}</span>
            </div>
            <div class="info-row" id="vault-total-value-${vault.address.toLowerCase()}">
                <span class="label">总市值</span>
                <span class="value price-loading">加载中...</span>
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

    // 更新总市值（优先使用已加载的价格数据）
    // 如果已有价格数据，立即更新；否则异步加载
    if (vault.priceData) {
        // 使用已加载的价格数据，使用 setTimeout 确保 DOM 已更新
        setTimeout(() => {
            const valueEl = document.getElementById(`vault-total-value-${vault.address.toLowerCase()}`);
            if (valueEl) {
                const totalValue = calculateTotalValue(vault.contractBalanceFormatted || vault.totalDepositsFormatted, vault.priceData.price);
                const valueSpan = valueEl.querySelector('.value');
                if (valueSpan) {
                    valueSpan.textContent = totalValue;
                    valueSpan.classList.remove('price-loading');
                }
            }
        }, 0);
    } else if (vault.depositToken) {
        // 如果没有价格数据，等待批量价格加载完成（避免重复请求）
        // 如果 3 秒后还没有价格数据，再单独请求（可能是批量加载失败）
        setTimeout(() => {
            const valueEl = document.getElementById(`vault-total-value-${vault.address.toLowerCase()}`);
            if (!valueEl) return;

            // 先检查是否已经有价格数据（批量加载可能已完成）
            if (vault.priceData) {
                const totalValue = calculateTotalValue(vault.contractBalanceFormatted || vault.totalDepositsFormatted, vault.priceData.price);
                const valueSpan = valueEl.querySelector('.value');
                if (valueSpan) {
                    valueSpan.textContent = totalValue;
                    valueSpan.classList.remove('price-loading');
                }
                return;
            }

            // 如果还没有，再单独请求（作为兜底）
            getTokenPrice(vault.depositToken).then(priceData => {
                const valueSpan = valueEl.querySelector('.value');
                if (valueSpan) {
                    if (priceData) {
                        vault.priceData = priceData; // 缓存到 vault 对象
                        const totalValue = calculateTotalValue(vault.contractBalanceFormatted || vault.totalDepositsFormatted, priceData.price);
                        valueSpan.textContent = totalValue;
                    } else {
                        valueSpan.textContent = 'N/A';
                    }
                    valueSpan.classList.remove('price-loading');
                }
            }).catch(err => {
                console.warn(`获取金库 ${vault.address} 价格失败:`, err);
                const valueSpan = valueEl.querySelector('.value');
                if (valueSpan) {
                    valueSpan.textContent = 'N/A';
                    valueSpan.classList.remove('price-loading');
                }
            });
        }, 3000); // 等待 3 秒，给批量加载时间
    } else {
        // 没有代币地址，直接显示 N/A
        setTimeout(() => {
            const valueEl = document.getElementById(`vault-total-value-${vault.address}`);
            if (valueEl) {
                const valueSpan = valueEl.querySelector('.value');
                if (valueSpan) {
                    valueSpan.textContent = 'N/A';
                    valueSpan.classList.remove('price-loading');
                }
            }
        }, 0);
    }

    return div;
}

// 同步所有卡片头部的高度，确保对齐
function syncCardHeaderHeights() {
    // 同步"所有金库"视图中的卡片
    const allVaultsGrid = document.getElementById('vaultsGrid');
    if (allVaultsGrid) {
        const cardHeaders = allVaultsGrid.querySelectorAll('.card-header');
        if (cardHeaders.length > 0) {
            let maxHeight = 0;
            // 先找到最大高度
            cardHeaders.forEach(header => {
                header.style.height = 'auto'; // 重置高度以测量实际高度
                const height = header.offsetHeight;
                if (height > maxHeight) {
                    maxHeight = height;
                }
            });
            // 设置所有头部为相同高度
            cardHeaders.forEach(header => {
                header.style.height = maxHeight + 'px';
            });
        }
    }

    // 同步"我的金库"视图中的卡片
    const userVaultsGrid = document.getElementById('userVaultsGrid');
    if (userVaultsGrid) {
        const cardHeaders = userVaultsGrid.querySelectorAll('.card-header');
        if (cardHeaders.length > 0) {
            let maxHeight = 0;
            // 先找到最大高度
            cardHeaders.forEach(header => {
                header.style.height = 'auto'; // 重置高度以测量实际高度
                const height = header.offsetHeight;
                if (height > maxHeight) {
                    maxHeight = height;
                }
            });
            // 设置所有头部为相同高度
            cardHeaders.forEach(header => {
                header.style.height = maxHeight + 'px';
            });
        }
    }
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

        // 3. 找出所有未解锁金库（当前活跃期）
        const activeVaults = matchingVaults.filter(v => !v.consensusReached);

        if (activeVaults.length === 1) {
            // 只有一个活跃金库时，直接跳转
            goToVaultDetail(activeVaults[0].address);
        } else if (activeVaults.length > 1) {
            // 存在多个活跃金库时，让用户选择
            const tokenSymbol = matchingVaults[0].tokenSymbol || 'TOKEN';
            showVaultSelectionModal(activeVaults, tokenSymbol);
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


