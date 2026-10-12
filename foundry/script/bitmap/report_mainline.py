#!/usr/bin/env python3
"""Render per-call inputs/results/gas from a passing mainline `forge test -vvvv` trace.

Run from foundry/:
  forge test --match-path test/bitmap/BitmapMarketScenario.t.sol -vvvv > /tmp/bitmap-trace.txt
  python3 script/bitmap/report_mainline.py /tmp/bitmap-trace.txt
Gas is the outer target call frame, not transaction receipt gasUsed.
"""
import csv
import json
import re
import sys
from decimal import Decimal
from pathlib import Path

U = 1_000_000
T0 = 1_800_000_000
METHODS = {
    'approve', 'deposit', 'splitUSDC', 'orderBatchInsert', 'orderInsert',
    'sellShares', 'deleteOrder', 'updateVersion', 'mergeShares', 'setMarketState',
    'redeem', 'withdraw', 'getMarketFee', 'withDrawFee',
}
ROOT = re.compile(r'^    ├─ \[(\d+)\] (.*)$')
TEST = re.compile(r'^  \[\d+\] BitmapMarketScenarioTest::testMainlineEveryTransaction(Yes|No)Wins\(\)$')
DELEGATE = re.compile(r'^    │   ├─ \[\d+\] (\w+)::(\w+)\((.*)\) \[delegatecall\]$')
ADDR = {
    '0xe2f9ab810663f0df654698369cee4b73f8609c5e': 'Vault',
    '0xc51df35413b57941e825df2978b9d5a549dde648': 'Factory',
    '0x477cb1378bbc8e2fca70123c1fdaa3b61768cb69': 'M1',
}


def clean(value):
    value = re.sub(r'\s+\[\d+(?:\.\d+)?e[+-]?\d+\]', '', value)
    value = re.sub(r'([\w-]+): \[(0x[0-9a-fA-F]{40})\]',
                   lambda m: ADDR.get(m[2].lower(), m[1]), value)
    return value.replace('A-owner', 'A').replace('O-oracle', 'O')


def units(value):
    value = format(Decimal(value) / U, 'f')
    return value.rstrip('0').rstrip('.') if '.' in value else value


def fields(value):
    return dict(re.findall(r'(\w+): (.*?)(?=, \w+: |$)', clean(value)))


def events(row, name):
    return [fields(e['args']) for e in row['events'] if e['name'] == name]


def result(row):
    if row['status'] == 'Revert':
        return '回滚；' + row['return_data'] + '；余额/份额保持不变'
    method, actor = row['method'], row['actor']
    args = row['args'].split(', ')
    if method == 'approve':
        return f'授权Vault {units(args[-1])} USDC；返回true'
    if method == 'deposit':
        return f'钱包−{units(args[0])}；Vault可用+{units(args[0])}'
    if method == 'withdraw':
        return f'Vault可用−{units(args[0])}；钱包+{units(args[0])}'
    if method == 'splitUSDC':
        amount = units(args[0])
        return f'Vault可用−{amount}；自由YES+{amount}、NO+{amount}'
    if method == 'mergeShares':
        amount = units(args[0])
        return f'销毁{amount} YES+{amount} NO；Vault可用+{amount}'
    if method == 'setMarketState':
        return '状态=' + {'0': '交易中', '1': 'YES胜', '2': 'NO胜', '3': '暂停'}[args[0]]
    if method == 'redeem':
        e, = events(row, 'Redeem')
        total = int(e['deposit']) + int(e['shareAmount'])
        return f'返买单锁款{units(e["deposit"])}+赢家份额{units(e["shareAmount"])}={units(total)} USDC；清空份额记录'
    if method in ('getMarketFee', 'withDrawFee'):
        e, = events(row, 'GetMarketFee' if method == 'getMarketFee' else 'WithDrawFee')
        return ('归集平台费至Vault ' if method == 'getMarketFee' else '转至A钱包 ') + units(e['_USDCAmount'])
    parts = []
    trades = events(row, 'TradeInfo')
    if trades:
        qty = sum(int(e['shareAmount']) for e in trades)
        fee = sum(int(e['makerFeeAmount']) + int(e['marketFeeAmount']) for e in trades)
        rebate = sum(int(e['makerFeeAmount']) for e in trades)
        principal = sum(int(e['shareAmount']) * int(e['price']) // 100 for e in trades)
        buying = trades[0]['isBuy'] == 'true'
        side = 'YES' if trades[0]['isYes'] == 'true' else 'NO'
        parts.append(' → '.join(f'{e["maker"]} {units(e["shareAmount"])}@{e["price"]}' for e in trades))
        parts.append(f'{"买" if buying else "卖"}{units(qty)} {side}；本金{units(principal)}；手续费{units(fee)}')
        parts.append(f'{"支付" if buying else "到账"}{units(principal + fee if buying else principal - fee)}；maker返佣{units(rebate)}；平台费{units(fee-rebate)}')
        row.update(quantity_raw=qty, principal_raw=principal, fee_raw=fee,
                   rebate_raw=rebate, platform_fee_raw=fee-rebate)
    for e in events(row, 'ReleaseDeposit'):
        if trades and e['trader'] == actor:
            continue  # Taker net sell proceeds already shown above.
        if int(e['_USDCAmount']):
            parts.append(f'{e["trader"]}退回买单锁款{units(e["_USDCAmount"])}')
    for e in events(row, 'ReleaseDepositShareAmount'):
        if int(e['amount']):
            parts.append(f'{e["trader"]}解锁{units(e["amount"])} ' + ('YES' if e['isYes'] == 'true' else 'NO'))
    if method == 'orderBatchInsert':
        parts.insert(0, f'挂单{len(events(row, "OrderInsertInfo"))}笔，未成交')
        for e in events(row, 'LockDeposit'):
            if int(e['_USDCAmount']):
                parts.append(f'锁{units(e["_USDCAmount"])} USDC')
        for e in events(row, 'LockDepositShareAmount'):
            if int(e['amount']):
                parts.append(f'锁{units(e["amount"])} ' + ('YES' if e['isYes'] == 'true' else 'NO'))
    if method == 'updateVersion':
        parts.insert(0, f'版本={row["return_data"]}，全部旧单失效')
    return '；'.join(parts)


def parse(path):
    lines = path.read_text().splitlines()
    if 'Suite result: ok. 2 passed; 0 failed;' not in '\n'.join(lines[-12:]):
        raise ValueError('Require a complete passing two-mainline-test trace')
    rows = []
    branch = None
    actor = None
    timestamp = T0
    count = 0
    i = 0
    while i < len(lines):
        test = TEST.match(lines[i])
        if test:
            branch, count, timestamp = test[1].upper(), 0, T0
        root = ROOT.match(lines[i])
        if not root or not branch:
            i += 1
            continue
        start = i
        i += 1
        while i < len(lines) and not ROOT.match(lines[i]) and not TEST.match(lines[i]):
            i += 1
        body = lines[start+1:i]
        call = root[2]
        if call.startswith('VM::prank('):
            actor = clean(call[len('VM::prank('):-1])
            continue
        if call.startswith('VM::warp('):
            timestamp = int(clean(call[len('VM::warp('):-1]))
            continue
        if '[staticcall]' in call or call.startswith('VM::'):
            continue
        match = re.match(r'(.*)::(\w+)\((.*)\)$', call)
        if not match:
            continue
        target, method, args = match.groups()
        if method == 'fallback':
            child = next((DELEGATE.match(line) for line in body if DELEGATE.match(line)), None)
            if not child:
                continue
            target, method, args = child.groups()
        if method not in METHODS:
            continue
        count += 1
        return_line = next((line for line in reversed(body) if line.startswith('    │   └─ ← [')), '')
        end = re.search(r'← \[(\w+)\]\s*(.*)', return_line)
        if not end:
            raise ValueError(f'Missing root return at line {start+1}')
        ev = []
        for line in body:
            event = re.search(r'emit (\w+)\((.*)\)$', line)
            if event:
                ev.append(dict(name=event[1], args=clean(event[2])))
        row = dict(branch=branch, sequence=count, time_offset=timestamp-T0, actor=actor,
                   target=target, method=method, args=clean(args),
                   gas_call_frame=int(root[1]), status=end[1], return_data=clean(end[2]),
                   trace_line=start+1, events=ev)
        row['result'] = result(row)
        rows.append(row)
    for branch in ('YES', 'NO'):
        selection = [r for r in rows if r['branch'] == branch]
        assert len(selection) == 70, (branch, len(selection))
        assert sum(len(events(r, 'TradeInfo')) for r in selection) == 15
        assert sum(r.get('platform_fee_raw', 0) for r in selection) == 1_713_075
        assert sum(r['status'] == 'Revert' for r in selection) == 8
    return rows


INTRO = '''# Bitmap 主线逐笔执行报告

> 最新独立交易数据见[receipt 报告](bitmap-receipts/README.md)。本文件保留旧的测试调用帧gas口径；Monad按gasLimit收费，新报告同时记录gasUsed、gasLimit与实际扣款。

部署与配置过程另见[部署明细](bitmap-mainline-setup.md)。

两个完整主线测试均通过。覆盖入金、split、YES/NO批量做市、同价FIFO、跨价买入、部分成交、过期买单/卖单清理、撤单、版本失效、merge、暂停/恢复、两种胜负结算、提款与平台提费。共用主线加两种结算分支的每次合约调用均在下面列出，含预期回滚。

**覆盖边界：** 主线没有调用`buyUSDCAmount`；原有两个小测试涉及该接口，但不等于完整的预算/最小输出保护验证。没有覆盖跨价格卖出、暂停时拒绝交易、oracle替换、全部权限失败、交易排序竞争、随机交易及大订单簿压力。暂停/恢复当前只验证状态切换。终局后状态不可更改也尚未专项测试。

**金额结论：** 已测试成交的本金、taker手续费、maker返佣、平台费、退款与结算均通过逐笔账户断言。总入金9,000；split 2,200对；merge销毁700对；结算前剩1,500对。总taker手续费3.426150 = maker返佣1.713075 + 平台净费1.713075；两种结果下用户最终提款总额均为8,998.286925，加平台1.713075后等于9,000，Vault余额归零。

**交易语义：** `orderInsert`的报价仅用于触发吃单，不能作为每笔成交的最高买价/最低卖价；E传55仍成交58和60。这是当前已约定的实现行为，不能据此声称实现了严格限价保护。YES/NO独立撮合；split/merge提供成对份额生成和销毁，没有跨YES/NO订单自动合成撮合。到期单在结束时间当秒仍有效，之后由调用触发清理。市场最终结果由oracle手动设置。

## gas口径

- 数字来自`forge test --match-path test/bitmap/BitmapMarketScenario.t.sol -vvvv`中目标合约最外层调用帧；Vault使用代理fallback外层，Market使用clone外层，包含内部调用与delegatecall，不能再把子调用gas相加。
- **这是本次Foundry测试调用的执行gas，不是独立链上交易receipt的gasUsed。** 不包含测试断言/参考账本，也没有独立交易的完整成本口径；没有单独计算交易基础/calldata成本或交易级退款结算。测试内共享调用上下文及读写历史，不能直接视为真实用户发交易的精确报价。
- 使用仓库Monad/MonadTen配置，solc 0.8.28、prague、via_ir=true、optimizer=200，Forge 1.8.1。全部调用序列被一个测试函数串行执行；测试函数约1.20亿gas包括大批检查，不能当成任何一笔业务交易的gas。
- 未使用gas price换算MON费用。要给出独立交易账单，应在目标链或配置匹配的节点逐笔发送交易并读取receipt。

## 参数、输出与单位

金额/份额原始参数均为6位整数；`1000000=1 USDC/份`。价格55=0.55 USDC。T0=1800000000，时间列是相对T0的秒数；0时刻不同调用仍按编号顺序执行。

`orderInsert(price, shares, endTimestamp, isBuy, isYes)`；`sellShares(shares,isYes,minUSDCOut)`；`deleteOrder(price,index,isYes)`。批量数组每项为`(prices,shareAmounts,endTimestamps,isBuy,isYes)`，在末尾逐项展开。地址别名Vault/M1对应测试部署的代理/市场。

多数交易函数没有ABI返回值；“输出”列是事件和测试已验证的账户状态变化。approve实际返回true，updateVersion实际返回新版本1；其余原始Return/Revert内容保存在JSON/CSV。
'''


def render(rows, output):
    output.mkdir(parents=True, exist_ok=True)
    base = output / 'bitmap-mainline-execution'
    base.with_suffix('.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2)+'\n')
    columns = ['branch', 'sequence', 'time_offset', 'actor', 'method', 'args',
               'result', 'gas_call_frame', 'status', 'return_data', 'trace_line']
    with base.with_suffix('.csv').open('w', newline='', encoding='utf-8-sig') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)
    yes = [r for r in rows if r['branch'] == 'YES']
    no = [r for r in rows if r['branch'] == 'NO']
    # Both branches execute the exact same 41 calls before resolution.
    split = next(i for i, r in enumerate(yes) if r['method'] == 'setMarketState' and r['args'] == '1')
    for l, r in zip(yes[:split], no[:split]):
        for key in ('actor', 'method', 'args', 'result', 'gas_call_frame'):
            assert l[key] == r[key], (key, l, r)
    text = [INTRO]
    for title, subset in [('共用交易主线', yes[:split]), ('YES胜：结算与提款', yes[split:]), ('NO胜：结算与提款', no[split:])]:
        text += [f'## {title}\n', '| 编号 | 时间 | 用户 | 调用及原始参数 | 已验证输出 | 调用gas |', '|---|---:|---|---|---|---:|']
        for r in subset:
            args = r['args'] if r['method'] != 'orderBatchInsert' else f'数组，见批次{r["sequence"]}'
            text.append(f'| {r["sequence"]} | +{r["time_offset"]} | {r["actor"]} | `{r["method"]}({args})` | {r["result"]} | {r["gas_call_frame"]:,} |')
        text.append('')
    text += ['## 批量挂单完整输入\n', '每个批次只是一笔外层调用，gas为整批数值，不虚构每个数组项的独立gas。\n', '| 批次 | 项 | 用户 | YES/NO | 买/卖 | 价格 | 数量原始值 | endTimestamp |', '|---|---:|---|---|---|---:|---:|---:|']
    for r in yes:
        if r['method'] != 'orderBatchInsert':
            continue
        for index, item in enumerate(re.findall(r'OrderBatch\(\{ (.*?) \}\)', r['args'])):
            e = fields(item)
            text.append(f'| {r["sequence"]} | {index} | {r["actor"]} | {"YES" if e["isYes"] == "true" else "NO"} | {"买" if e["isBuy"] == "true" else "卖"} | {e["prices"]} | {e["shareAmounts"]} | {e["endTimestamps"]} |')
    text += ['', '## 逐笔成交与maker所得\n', '以下15行是7笔吃单调用内部的fill；gas已计入其外层调用，不重复计算。买方maker支付的本金来自先前挂单锁款，其本次可用现金只增加返佣。\n', '| 调用编号 | maker | taker | taker方向 | 价格 | 份额 | 本金 | taker费 | maker返佣 | 平台费 | maker可用USDC增量 |', '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for r in yes:
        for e in events(r, 'TradeInfo'):
            p = int(e['shareAmount']) * int(e['price']) // 100
            rebate = int(e['makerFeeAmount'])
            platform = int(e['marketFeeAmount'])
            maker_cash = rebate + (p if e['isBuy'] == 'true' else 0)
            direction = ('买' if e['isBuy'] == 'true' else '卖') + ('YES' if e['isYes'] == 'true' else 'NO')
            text.append(f'| {r["sequence"]} | {e["maker"]} | {e["taker"]} | {direction} | {e["price"]} | {units(e["shareAmount"])} | {units(p)} | {units(rebate+platform)} | {units(rebate)} | {units(platform)} | {units(maker_cash)} |')
    text += ['', '## 复现\n', '```bash', 'forge test --match-path test/bitmap/BitmapMarketScenario.t.sol -vvvv > /tmp/bitmap-trace.txt', 'python3 script/bitmap/report_mainline.py /tmp/bitmap-trace.txt', '```', '', 'JSON保留每次调用的事件、Return/Revert、trace行号及逐fill数值；CSV便于排序和筛选。部署与初始测试币铸造属于setUp，不包含在本报告的70次/分支用户调用中。']
    base.with_suffix('.md').write_text('\n'.join(text)+'\n')
    print(f'{len(rows)} calls exported to {base}.{{md,csv,json}}; {split} common calls')


if __name__ == '__main__':
    render(parse(Path(sys.argv[1])), Path(__file__).resolve().parents[2] / 'docs')
