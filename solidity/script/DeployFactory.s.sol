// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../src/ConsensusVaultFactory.sol";

contract DeployFactory is Script {
    function run() external returns (ConsensusVaultFactory factory) {
        vm.startBroadcast();
        factory = new ConsensusVaultFactory();
        vm.stopBroadcast();
    }
}
