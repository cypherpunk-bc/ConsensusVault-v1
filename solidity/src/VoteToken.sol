 // // SPDX-License-Identifier: MIT
// pragma solidity ^0.8.19;

// import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// import "@openzeppelin/contracts/access/Ownable.sol";

// /**
//  * @title VoteToken
//  * @dev 用于投票权重表示的 ERC20 代币
//  *
//  * 主要特性：
//  * - 仅金库可以铸造代币
//  * - 初始时可转移
//  * - 投票后不可转移
//  * - 提取时销毁
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

//     // 仅金库修饰符
//     modifier onlyVault() {
//         require(msg.sender == vault, "只有金库才能调用");
//         _;
//     }

//     // 设置金库地址
//     function setVault(address _vault) external onlyOwner {
//         require(_vault != address(0), "无效的金库地址");
//         require(vault == address(0), "金库已设置");
//         vault = _vault;
//         emit VaultSet(_vault);
//     }

//     // 设置代币可转移性
//     function setTransferable(bool _transferable) external onlyVault {
//         transferable = _transferable;
//         emit TransferabilityChanged(_transferable);
//     }

//     // 铸造代币
//     function mint(address _to, uint256 _amount) external onlyVault {
//         _mint(_to, _amount);
//     }

//     // 销毁代币
//     function burn(address _from, uint256 _amount) external onlyVault {
//         _burn(_from, _amount);
//     }

//     // 代币转移前的钩子函数
//     function _beforeTokenTransfer(
//         address from,
//         address to,
//         uint256 amount
//     ) internal virtual override {
//         super._beforeTokenTransfer(from, to, amount);
//         // 允许铸造 (from == address(0))
//         // 允许销毁 (to == address(0))
//         // 如果不可转移则阻止转移
//         if (from != address(0) && to != address(0)) {
//             require(transferable, "代币不可转移");
//         }
//     }
// }
