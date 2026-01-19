 // // SPDX-License-Identifier: MIT
// pragma solidity ^0.8.19;

// import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// import "@openzeppelin/contracts/access/Ownable.sol";

// /**
//  * @title VoteToken
//  * @dev ERC20 Token for vote weight representation
//  *
//  * Key Features:
//  * - Only vault can mint tokens
//  * - Initially transferrable
//  * - Becomes non-transferrable after vote
//  * - Burns on withdrawal
//  */
// contract VoteToken is ERC20, Ownable {
//     address public vault;
//     bool public transferable = true;

//     event VaultSet(address indexed vault);
//     event TransferabilityChanged(bool transferable);

//     constructor(
//         string memory _name,
//         string memory _symbol
//     ) ERC20(_name, _symbol) {}

//     modifier onlyVault() {
//         require(msg.sender == vault, "Only vault can call");
//         _;
//     }

//     function setVault(address _vault) external onlyOwner {
//         require(_vault != address(0), "Invalid vault address");
//         require(vault == address(0), "Vault already set");
//         vault = _vault;
//         emit VaultSet(_vault);
//     }

//     function setTransferable(bool _transferable) external onlyVault {
//         transferable = _transferable;
//         emit TransferabilityChanged(_transferable);
//     }

//     function mint(address _to, uint256 _amount) external onlyVault {
//         _mint(_to, _amount);
//     }

//     function burn(address _from, uint256 _amount) external onlyVault {
//         _burn(_from, _amount);
//     }

//     function _beforeTokenTransfer(
//         address from,
//         address to,
//         uint256 amount
//     ) internal virtual override {
//         super._beforeTokenTransfer(from, to, amount);
//         // Allow mint (from == address(0))
//         // Allow burn (to == address(0))
//         // Block transfers if not transferable
//         if (from != address(0) && to != address(0)) {
//             require(transferable, "Token not transferable");
//         }
//     }
// }
