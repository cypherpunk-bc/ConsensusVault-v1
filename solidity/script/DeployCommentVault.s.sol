// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../src/CommentVault.sol";

contract DeployCommentVault is Script {
    function run() external returns (CommentVault commentVault) {
        vm.startBroadcast();
        commentVault = new CommentVault();
        vm.stopBroadcast();
        
        console.log("CommentVault deployed at:", address(commentVault));
    }
}
