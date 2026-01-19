// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ConsensusVault - 简化版（无 VToken）
 * @dev 直接使用 userInfo 管理权益，无需额外的代币合约
 *
 * 核心设计：
 * 1. 存款 → 记录 principal 到 userInfo
 * 2. 投票 → 标记已投票，不销毁任何东西
 * 3. 捐赠 → 按 principal 比例分配给所有用户
 * 4. 提现 → 本金 + 分红，最后一人拿走全部余额
 *
 * 优势：
 * - 代码简单，只有一套账本
 * - 无需维护额外的 Token 合约
 * - 逻辑清晰，便于审计
 *
 * 限制：
 * - 无二级市场交易
 * - 存款后不可转让权益
 */
contract ConsensusVault is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant PRECISION = 1e12;

    IERC20 public depositToken;

    uint256 public totalPrincipal; // 总本金
    uint256 public accRewardPerShare; // 累积分红/本金
    uint256 public totalVoteWeight; // 已投票的权重
    uint256 public totalDonations; // 累计捐赠总额
    bool public consensusReached;

    struct UserInfo {
        uint256 principal; // 用户本金
        uint256 rewardDebt; // 分红债务（防止薅历史捐赠）
        bool hasVoted; // 是否已投票
    }

    mapping(address => UserInfo) public userInfo;

    event Deposited(address indexed user, uint256 amount);
    event Voted(address indexed user, uint256 voteWeight);
    event Donated(address indexed donor, uint256 amount);
    event ConsensusAchieved(uint256 totalVoteWeight);
    event Withdrawn(address indexed user, uint256 principal, uint256 reward);

    constructor(address _depositToken) {
        require(_depositToken != address(0), "Invalid deposit token");
        depositToken = IERC20(_depositToken);
    }

    // ============ 存款 ============

    function deposit(uint256 _amount) external nonReentrant {
        _depositFor(msg.sender, _amount);
    }

    function depositFor(
        address _user,
        uint256 _amount
    ) external onlyOwner nonReentrant {
        _depositFor(_user, _amount);
    }

    function _depositFor(address _user, uint256 _amount) internal {
        require(!consensusReached, "Consensus reached, deposit closed");
        require(_amount > 0, "Amount must be > 0");

        // 转入存款
        depositToken.safeTransferFrom(msg.sender, address(this), _amount);

        // 计算当前累积的待领取收益（追加存款前）
        uint256 pendingReward = 0;
        if (userInfo[_user].principal > 0) {
            pendingReward =
                ((userInfo[_user].principal * accRewardPerShare) / PRECISION) -
                userInfo[_user].rewardDebt;
        }

        // 更新全局状态
        totalPrincipal += _amount;

        // 更新用户本金
        userInfo[_user].principal += _amount;

        // 更新分红债务：新本金对应的债务 - 之前累积的待领取收益
        // 这样确保 pendingReward 计算时能保留之前的收益
        userInfo[_user].rewardDebt =
            ((userInfo[_user].principal * accRewardPerShare) / PRECISION) -
            pendingReward;

        emit Deposited(_user, _amount);
    }

    // ============ 投票 ============

    function voteForConsensus() external nonReentrant {
        require(!consensusReached, "Consensus already reached");
        require(!userInfo[msg.sender].hasVoted, "Already voted");

        uint256 voteWeight = userInfo[msg.sender].principal;
        require(voteWeight > 0, "No stake to vote");

        // 标记已投票
        userInfo[msg.sender].hasVoted = true;

        // 累计投票权重
        totalVoteWeight += voteWeight;

        // 共识检查（超过 50% 投票）
        if (totalVoteWeight * 2 > totalPrincipal) {
            consensusReached = true;
            emit ConsensusAchieved(totalVoteWeight);
        }

        emit Voted(msg.sender, voteWeight);
    }

    // ============ 捐赠 ============

    function donate(uint256 _amount) external nonReentrant {
        require(!consensusReached, "Consensus reached, donation closed");
        require(_amount > 0, "Amount must be > 0");
        require(totalPrincipal > 0, "No deposits yet");

        depositToken.safeTransferFrom(msg.sender, address(this), _amount);

        // 更新累积分红
        accRewardPerShare += (_amount * PRECISION) / totalPrincipal;

        // 更新累计捐赠总额
        totalDonations += _amount;

        emit Donated(msg.sender, _amount);
    }

    // ============ 提现 ============

    function withdrawAll() external nonReentrant {
        require(consensusReached, "Consensus not reached, cannot withdraw");

        uint256 userPrincipal = userInfo[msg.sender].principal;
        require(userPrincipal > 0, "Nothing to withdraw");

        // 计算应得分红
        uint256 pendingReward = (userPrincipal * accRewardPerShare) /
            PRECISION -
            userInfo[msg.sender].rewardDebt;
        uint256 totalAmount = userPrincipal + pendingReward;

        // 更新全局状态
        totalPrincipal -= userPrincipal;

        // 清零用户数据
        userInfo[msg.sender].principal = 0;
        userInfo[msg.sender].rewardDebt = 0;

        // 最后一人提取全部余额（解决 dust 问题）
        if (totalPrincipal == 0) {
            totalAmount = depositToken.balanceOf(address(this));
        }

        // 转出资金
        depositToken.safeTransfer(msg.sender, totalAmount);

        emit Withdrawn(msg.sender, userPrincipal, pendingReward);
    }

    // ============ 只读视图 ============

    function hasVoted(address _user) external view returns (bool) {
        return userInfo[_user].hasVoted;
    }
}
