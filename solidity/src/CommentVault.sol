// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title CommentVault - 独立的留言合约
 * @dev 为 ConsensusVault 提供留言功能
 *
 * 特性：
 * - 按金库地址分组存储留言
 * - 支持关联操作类型和交易哈希
 * - 永久保存在链上，所有用户可见
 */
contract CommentVault {
    uint256 public constant MAX_COMMENT_LENGTH = 200; // 限制留言长度，节省 gas

    // 留言结构
    struct Comment {
        address user; // 留言用户地址
        string message; // 留言内容
        bytes32 action; // 关联的操作类型（deposit/vote/donate/withdraw）
        bytes32 txHash; // 关联的交易哈希
        uint256 timestamp; // 时间戳
        uint256 blockNumber; // 区块号
    }

    // 金库地址 => 留言列表
    mapping(address => Comment[]) public vaultComments;

    // 金库地址 => 留言数量
    mapping(address => uint256) public commentCount;

    event CommentAdded(
        address indexed vaultAddress,
        address indexed user,
        string message,
        bytes32 action,
        bytes32 txHash,
        uint256 timestamp,
        uint256 blockNumber
    );

    /**
     * @dev 添加留言
     * @param _vaultAddress 金库地址
     * @param _message 留言内容（最多200字符）
     * @param _action 操作类型（可选，如 "deposit", "vote", "donate", "withdraw"）
     * @param _txHash 交易哈希（可选，关联的操作交易哈希）
     */
    function addComment(
        address _vaultAddress,
        string calldata _message,
        bytes32 _action,
        bytes32 _txHash
    ) external {
        require(_vaultAddress != address(0), "Invalid vault address");
        require(bytes(_message).length > 0, "Message cannot be empty");
        require(
            bytes(_message).length <= MAX_COMMENT_LENGTH,
            "Message too long"
        );

        Comment memory newComment = Comment({
            user: msg.sender,
            message: _message,
            action: _action,
            txHash: _txHash,
            timestamp: block.timestamp,
            blockNumber: block.number
        });

        vaultComments[_vaultAddress].push(newComment);
        commentCount[_vaultAddress]++;

        emit CommentAdded(
            _vaultAddress,
            msg.sender,
            _message,
            _action,
            _txHash,
            block.timestamp,
            block.number
        );
    }

    /**
     * @dev 获取指定金库的留言数量
     * @param _vaultAddress 金库地址
     * @return 留言数量
     */
    function getCommentCount(
        address _vaultAddress
    ) external view returns (uint256) {
        return commentCount[_vaultAddress];
    }

    /**
     * @dev 获取指定金库的留言列表（分页，最新的在前）
     * @param _vaultAddress 金库地址
     * @param _offset 起始位置（从0开始）
     * @param _limit 返回数量
     * @return 留言数组
     */
    function getComments(
        address _vaultAddress,
        uint256 _offset,
        uint256 _limit
    ) external view returns (Comment[] memory) {
        uint256 total = commentCount[_vaultAddress];
        if (_offset >= total) {
            return new Comment[](0);
        }

        uint256 end = _offset + _limit;
        if (end > total) {
            end = total;
        }

        uint256 length = end - _offset;
        Comment[] memory result = new Comment[](length);

        // 从后往前取（最新的在前）
        Comment[] storage comments = vaultComments[_vaultAddress];
        for (uint256 i = 0; i < length; i++) {
            uint256 index = total - 1 - _offset - i;
            result[i] = comments[index];
        }

        return result;
    }

    /**
     * @dev 获取指定金库的所有留言（用于小数据量场景）
     * @param _vaultAddress 金库地址
     * @return 留言数组
     */
    function getAllComments(
        address _vaultAddress
    ) external view returns (Comment[] memory) {
        return vaultComments[_vaultAddress];
    }
}
