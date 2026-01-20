// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./ConsensusVault.sol";

/**
 * @title ConsensusVaultFactory
 * @dev Factory contract for creating ConsensusVault instances
 *
 * Features:
 * - Creates new vault instances with specified deposit token
 * - Tracks all created vaults
 * - Transfers ownership to creator
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
     * @dev Creates a new ConsensusVault instance with initial deposit (atomic)
     * @param _depositToken The ERC20 token to be used for deposits
     * @param _initialAmount Initial deposit amount (must be > 0)
     * @param _name Custom vault name (optional, can be empty string)
     * @return vaultAddress The address of the newly created vault
     */
    function createVault(
        address _depositToken,
        uint256 _initialAmount,
        string memory _name
    ) external returns (address vaultAddress) {
        require(_depositToken != address(0), "Invalid deposit token");
        require(_initialAmount > 0, "Initial deposit required");

        // Create new vault (factory becomes vault.factory)
        ConsensusVault vault = new ConsensusVault(_depositToken, _name);
        vaultAddress = address(vault);

        // Transfer initial deposit to vault
        IERC20(_depositToken).safeTransferFrom(msg.sender, vaultAddress, _initialAmount);

        // Record initial deposit (no transfer inside)
        vault.creditInitialDeposit(msg.sender, _initialAmount);

        // Store vault address
        vaults.push(vaultAddress);

        emit VaultCreated(vaultAddress, _depositToken, msg.sender);

        return vaultAddress;
    }

    /**
     * @dev Returns all created vault addresses
     * @return Array of vault addresses
     */
    function getVaults() external view returns (address[] memory) {
        return vaults;
    }

    /**
     * @dev Returns the number of vaults created
     * @return Number of vaults
     */
    function getVaultsCount() external view returns (uint256) {
        return vaults.length;
    }

    /**
     * @dev Returns the version of the factory
     * @return Version string
     */
    function version() external pure returns (string memory) {
        return "1.0.0";
    }
}
