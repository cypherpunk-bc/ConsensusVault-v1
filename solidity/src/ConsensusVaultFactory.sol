// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

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
    address[] public vaults;

    event VaultCreated(
        address indexed vaultAddress,
        address indexed depositToken,
        address indexed creator
    );

    /**
     * @dev Creates a new ConsensusVault instance
     * @param _depositToken The ERC20 token to be used for deposits
     * @return vaultAddress The address of the newly created vault
     */
    function createVault(
        address _depositToken
    ) external returns (address vaultAddress) {
        require(_depositToken != address(0), "Invalid deposit token");

        // Create new vault
        ConsensusVault vault = new ConsensusVault(_depositToken);

        // Transfer ownership to creator
        vault.transferOwnership(msg.sender);

        // Store vault address
        vaultAddress = address(vault);
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
