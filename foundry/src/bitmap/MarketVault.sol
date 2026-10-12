// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;
import "./Vault.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract MarketVault is ReentrancyGuard {
    uint96 internal constant RATE_SCALE = 10_000;

    struct TraderInfo {
        uint96 deposit;
        uint96 yesAmount;
        uint96 yesDepositAmount;
        uint96 noAmount;
        uint96 noDepositAmount;
    }
    // Share is represented with 6 decimals
    mapping(address => TraderInfo) public traderInfos;

    IVault public vault;

    uint8 public marketState; // 0: open, 1: yesWin, 2: noWin, 3: paused
    address public oracle;
    //fee = C × feeRate × p × (1 - p) / RATE_SCALE, where C is the trade amount, p is the price, feeRate is the taker fee rate or maker rebate rate
    uint96 public takerFeeRate; // takerFeeRate=100 --> 1% fee rate, can be adjusted by governance
    uint96 public makerRebateRate; // makerRebateRate=100 --> 1% rebate rate, can be adjusted by governance.
    //MakerReceiveFeePerShare = makerRebateRate * getFeePerShare(price)
    uint96 public marketFeeReceived; // marketFeeReceived is the total fee received by the market.

    event SetMarketState(uint8 _state);
    event SetOracle(address _oracle);
    event LockDepositShareAmount(
        uint96 amount,
        address indexed trader,
        bool isYes
    );
    event ReleaseDepositShareAmount(
        uint96 amount,
        address indexed trader,
        bool isYes
    );
    event SplitUSDC(address indexed trader, uint96 _USDCAmount);
    event MergeShares(address indexed trader, uint96 _USDCAmount);
    event Redeem(
        address indexed trader,
        uint96 deposit,
        uint96 shareAmount,
        bool isYes
    );

    event Debug(uint256);

    modifier onlyOracle() {
        require(msg.sender == oracle, "Only oracle can call this function");
        _;
    }

    modifier onlyOpen() {
        require(marketState == 0, "Market is not open");
        _;
    }

    function _marketVaultInit(
        address _vault,
        address _oracle,
        uint96 _feeRate,
        uint96 _makerRebateRate
    ) internal {
        require(_vault != address(0), "Invalid vault");
        require(_oracle != address(0), "Invalid oracle");
        require(_feeRate <= RATE_SCALE, "Invalid fee rate");
        require(_makerRebateRate <= RATE_SCALE, "Invalid maker rebate rate");

        vault = IVault(_vault);
        oracle = _oracle;
        takerFeeRate = _feeRate;
        makerRebateRate = _makerRebateRate;
        marketState = 0; // Initialize as open
    }

    function getFeePerShare(
        uint8 _price
    ) public view returns (uint96 takerFeeRateInPrice) {
        require(_price > 0 && _price < 101, "Invalid price");

        takerFeeRateInPrice =
            ((takerFeeRate * _price * (100 - _price)) * 1_000_000) /
            RATE_SCALE /
            (100 * 100);
    }

    function setMarketState(uint8 _state) external onlyOracle {
        require(
            _state <= 3 && (marketState == 0 || marketState == 3),
            "Invalid market state"
        );
        marketState = _state;

        emit SetMarketState(_state);
    }

    function setOracle(address _oracle) external onlyOracle {
        require(_oracle != address(0), "Invalid oracle address");
        oracle = _oracle;

        emit SetOracle(_oracle);
    }

    function lockDepositShareAmount(
        uint96 amount,
        address trader,
        bool isYes
    ) internal {
        TraderInfo storage info = traderInfos[trader];
        if (isYes) {
            require(info.yesAmount >= amount, "Insufficient balance to lock");
            info.yesAmount -= amount;
            info.yesDepositAmount += amount;
        } else {
            require(info.noAmount >= amount, "Insufficient balance to lock");
            info.noAmount -= amount;
            info.noDepositAmount += amount;
        }

        emit LockDepositShareAmount(amount, trader, isYes);
    }

    function releaseDepositShareAmount(
        uint96 amount,
        address trader,
        bool isYes
    ) internal {
        TraderInfo storage info = traderInfos[trader];
        if (isYes) {
            require(
                info.yesDepositAmount >= amount,
                "Insufficient yes deposit to release"
            );
            info.yesDepositAmount -= amount;
            info.yesAmount += amount;
        } else {
            require(
                info.noDepositAmount >= amount,
                "Insufficient no deposit to release"
            );
            info.noDepositAmount -= amount;
            info.noAmount += amount;
        }

        emit ReleaseDepositShareAmount(amount, trader, isYes);
    }

    function _applyMakerFee(
        MarkerResultInfo[8] memory makerFeeInfos,
        uint8 makerFeeInfoCount,
        uint96 _USDCAmount,
        address trader,
        bool isEnd
    ) internal returns (uint8) {
        makerFeeInfos[makerFeeInfoCount] = MarkerResultInfo({
            _USDCAmount: _USDCAmount,
            trader: trader
        });
        makerFeeInfoCount++;

        if ((isEnd && makerFeeInfoCount > 0) || makerFeeInfoCount >= 8) {
            vault.applyMakerResult(makerFeeInfos, makerFeeInfoCount);
            makerFeeInfoCount = 0;
        }

        return makerFeeInfoCount;
    }

    function splitUSDC(uint96 _USDCAmount) external onlyOpen nonReentrant {
        require(
            _USDCAmount > 1_000_000,
            "USDC amount must be greater than zero"
        );

        vault.lockDeposit(_USDCAmount, msg.sender);
        traderInfos[msg.sender].yesAmount += _USDCAmount;
        traderInfos[msg.sender].noAmount += _USDCAmount;

        emit SplitUSDC(msg.sender, _USDCAmount);
    }

    function mergeShares(uint96 amount) external nonReentrant {
        TraderInfo storage info = traderInfos[msg.sender];
        require(
            info.yesAmount >= amount && info.noAmount >= amount,
            "Insufficient shares to merge"
        );

        info.yesAmount -= amount;
        info.noAmount -= amount;

        vault.releaseDeposit(amount, msg.sender);

        emit MergeShares(msg.sender, amount);
    }

    function redeem() external nonReentrant {
        require(
            marketState == 1 || marketState == 2,
            "Market is not in a redeemable state"
        );
        require(
            traderInfos[msg.sender].yesDepositAmount > 0 ||
                traderInfos[msg.sender].noDepositAmount > 0 ||
                traderInfos[msg.sender].yesAmount > 0 ||
                traderInfos[msg.sender].noAmount > 0 ||
                traderInfos[msg.sender].deposit > 0,
            "No shares to redeem"
        );

        if (marketState == 1) {
            uint96 yesDepositAmount = traderInfos[msg.sender].yesDepositAmount +
                traderInfos[msg.sender].yesAmount +
                traderInfos[msg.sender].deposit;

            vault.releaseDeposit(yesDepositAmount, msg.sender);

            emit Redeem(
                msg.sender,
                traderInfos[msg.sender].deposit,
                traderInfos[msg.sender].yesDepositAmount +
                    traderInfos[msg.sender].yesAmount,
                true
            );

            delete traderInfos[msg.sender];
        } else if (marketState == 2) {
            uint96 noDepositAmount = traderInfos[msg.sender].noDepositAmount +
                traderInfos[msg.sender].noAmount +
                traderInfos[msg.sender].deposit;

            vault.releaseDeposit(noDepositAmount, msg.sender);

            emit Redeem(
                msg.sender,
                traderInfos[msg.sender].deposit,
                traderInfos[msg.sender].noDepositAmount +
                    traderInfos[msg.sender].noAmount,
                false
            );

            delete traderInfos[msg.sender];
        }
    }

    function withDrawMarketFee() external returns (uint96) {
        require(msg.sender == address(vault), "Only vault");

        uint96 _marketFeeReceived = marketFeeReceived;
        marketFeeReceived = 0;
        return _marketFeeReceived;
    }
}
