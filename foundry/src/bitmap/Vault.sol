// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

struct MarkerResultInfo {
    uint96 _USDCAmount;
    address trader;
}

contract Vault is
    UUPSUpgradeable,
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    mapping(address => uint96) public balances;
    mapping(address => bool) public markets;
    address public USDCAddress;
    address public marketFactory;
    uint96 public totalMarketFeeReceived;

    event SetMarketFactory(address marketFactory);
    event RegisterMarket(address market);
    event Deposit(address indexed trader, uint96 _USDCAmount);
    event WithDraw(address indexed trader, uint96 _USDCAmount);
    event LockDeposit(
        address market,
        address indexed trader,
        uint96 _USDCAmount
    );
    event ReleaseDeposit(
        address market,
        address indexed trader,
        uint96 _USDCAmount
    );
    // event ApplyMakerResult(address market, MarkerResultInfo[8] results);
    event ApplyMakerResult(address market, MarkerResultInfo[] results);
    event GetMarketFee(address market, uint96 _USDCAmount);
    event WithDrawFee(address owner, uint96 _USDCAmount);

    modifier marketCreated() {
        require(markets[msg.sender], "Market does not exist");
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _USDCAddress) public initializer {
        require(_USDCAddress != address(0), "Invalid USDC address");
        __Ownable_init(msg.sender);
        USDCAddress = _USDCAddress;
    }

    function setMarketFactory(address _marketFactory) external onlyOwner {
        require(_marketFactory != address(0), "Invalid market factory");
        marketFactory = _marketFactory;

        emit SetMarketFactory(_marketFactory);
    }

    function registerMarket(address market) external {
        require(
            msg.sender == marketFactory,
            "Only MarketFactory can register markets"
        );
        require(markets[market] != true,"Market registered");
        require(market != address(0),"Invalid market address");

        markets[market] = true;

        emit RegisterMarket(market);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function deposit(uint96 amount) external nonReentrant {
        // Transfer USDC from the sender to the vault
        IERC20(USDCAddress).safeTransferFrom(msg.sender, address(this), amount);
        //emit Deposit(msg.sender, amount);
        balances[msg.sender] += amount;

        emit Deposit(msg.sender, amount);
    }

    function withdraw(uint96 amount) external nonReentrant {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        IERC20(USDCAddress).safeTransfer(msg.sender, amount);

        emit WithDraw(msg.sender, amount);
    }

    function lockDeposit(uint96 amount, address trader) external marketCreated {
        require(balances[trader] >= amount, "Insufficient balance to lock");
        balances[trader] -= amount;

        emit LockDeposit(msg.sender, trader, amount);
    }

    function releaseDeposit(
        uint96 amount,
        address trader
    ) external marketCreated {
        balances[trader] += amount;

        emit ReleaseDeposit(msg.sender, trader, amount);
    }

    function applyMakerResult(
        MarkerResultInfo[8] calldata results,
        uint8 count
    ) external marketCreated {
        require(count <= 8, "Invalid count");
        MarkerResultInfo[] memory result = new MarkerResultInfo[](count);

        for (uint8 i = 0; i < count; i++) {
            balances[results[i].trader] += results[i]._USDCAmount;
            result[i] = results[i];
        }

        emit ApplyMakerResult(msg.sender, result);

        // for (uint8 i = 0; i < count; i++) {
        //     balances[results[i].trader] += results[i]._USDCAmount;
        // }

        // emit ApplyMakerResult(msg.sender, results);
    }

    function getMarketFee(address market) external nonReentrant onlyOwner {
        require(markets[market] == true, "Market does not exist");
        uint96 _USDCAmount = IMarket(market).withDrawMarketFee();
        totalMarketFeeReceived += _USDCAmount;

        emit GetMarketFee(market, _USDCAmount);
    }

    function withDrawFee() external nonReentrant onlyOwner {
        uint96 _totalMarketFeeReceived = totalMarketFeeReceived;
        totalMarketFeeReceived = 0;
        IERC20(USDCAddress).safeTransfer(msg.sender, _totalMarketFeeReceived);

        emit WithDrawFee(msg.sender, _totalMarketFeeReceived);
    }
}

interface IVault {
    function lockDeposit(uint96 amount, address trader) external;

    function releaseDeposit(uint96 amount, address trader) external;

    function applyMakerResult(
        MarkerResultInfo[8] memory results,
        uint8 count
    ) external;

    function registerMarket(address market) external;
}

interface IMarket {
    function withDrawMarketFee() external returns (uint96);
}
