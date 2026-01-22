// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./ConsensusVault.sol";

/**
 * @title ConsensusVaultFactory
 * @dev 用于创建 ConsensusVault 金库实例的工厂合约
 *
 * 特性：
 * - 创建绑定指定存款代币的新金库实例
 * - 记录所有已创建的金库地址
 * - 首笔存款由创建者提供，并直接存入新金库
 */
contract ConsensusVaultFactory {
    using SafeERC20 for IERC20;

    address[] public vaults;

    event VaultCreated(
        address indexed vaultAddress,
        address indexed depositToken,
        address indexed creator
    );

    /**
     * @dev 创建一个带有首笔存款的新 ConsensusVault 金库（原子操作）
     * @param _depositToken 作为存款资产的 ERC20 代币地址
     * @param _initialAmount 首笔存款金额（必须 > 0）
     * @param _name 自定义金库名称（可为空字符串）
     * @return vaultAddress 新创建的金库合约地址
     */
    function createVault(
        address _depositToken,
        uint256 _initialAmount,
        string memory _name
    ) external returns (address vaultAddress) {
        require(_depositToken != address(0), "Invalid deposit token");
        require(_initialAmount > 0, "Initial deposit required");

        // 创建新金库（工厂地址将记录在 vault.factory 中）
        ConsensusVault vault = new ConsensusVault(_depositToken, _name);
        vaultAddress = address(vault);

        // 将首笔存款从创建者转入金库合约
        IERC20(_depositToken).safeTransferFrom(
            msg.sender,
            vaultAddress,
            _initialAmount
        );

        // 在金库内部记账首笔存款（函数内部不再转账）
        vault.creditInitialDeposit(msg.sender, _initialAmount);

        // 记录金库地址
        vaults.push(vaultAddress);

        emit VaultCreated(vaultAddress, _depositToken, msg.sender);

        return vaultAddress;
    }

    /**
     * @dev 返回所有已创建的金库地址
     * @return 所有金库地址数组
     */
    function getVaults() external view returns (address[] memory) {
        return vaults;
    }

    /**
     * @dev 返回已创建金库的数量
     * @return 金库数量
     */
    function getVaultsCount() external view returns (uint256) {
        return vaults.length;
    }

    /**
     * @dev 返回工厂合约的版本信息
     * @return 版本字符串
     */
    function version() external pure returns (string memory) {
        return "Welcome to the jungle!";
    }
}
