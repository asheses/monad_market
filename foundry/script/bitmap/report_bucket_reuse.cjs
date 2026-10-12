#!/usr/bin/env node
// Reads only the dedicated bucket-reuse reports; does not execute any tests.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const variants=['bitmap','bitmapLink'];
const reports=Object.fromEntries(variants.map(v=>[v,JSON.parse(fs.readFileSync(path.join(root,`docs/${v}-bucket-reuse-receipts/receipts.json`)))]));
const phases=[['round1-makerA-batch','第一轮 maker A 批量4单'],['round1-makerB-batch','第一轮 maker B 批量4单'],['round1-makerC-single','第一轮 maker C 单笔55'],['round1-taker-buy18','第一轮 taker 买18份'],['round2-makerA-batch','第二轮 maker A 批量4单'],['round2-makerC-single','第二轮 maker C 单笔55'],['round2-taker-buy10','第二轮 taker 买10份']];
const mon=n=>{n=BigInt(n);return `${n/10n**18n}.${(n%10n**18n).toString().padStart(18,'0')}`.replace(/0+$/,'').replace(/\.$/,'');};
for(const [v,r] of Object.entries(reports)){
 assert.equal(r.metadata.selection,'bucket-reuse');assert.ok(!r.error,r.error);assert.equal(r.scenarios.length,1);
 assert.equal(r.scenarios[0].takerShares,'28000000');assert.equal(r.transactions.filter(t=>t.phase).length,7);
 for(const t of r.transactions){assert.ok(t.verified);assert.equal(t.status,'1');assert.equal(BigInt(t.nativeBalanceBefore)-BigInt(t.nativeBalanceAfter),BigInt(t.nativeFeeWei));}
 for(const [file,hash] of Object.entries(r.metadata.sourceHashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),hash,'source changed: '+file);
}
const rows=phases.map(([phase,label])=>{
 const byVariant=Object.fromEntries(variants.map(v=>[v,reports[v].transactions.find(t=>t.phase===phase)]));
 assert.deepEqual(byVariant.bitmap.args,byVariant.bitmapLink.args,'identical business inputs');
 return {phase,label,...Object.fromEntries(variants.map(v=>{const t=byVariant[v];return [v,{gasUsed:t.gasUsed,gasLimit:t.gasLimit,nativeFeeWei:t.nativeFeeWei,transactionHash:t.transactionHash,receiptIndex:t.index}];}))};
});
const totals=Object.fromEntries(variants.map(v=>[v,Object.fromEntries(['gasUsed','gasLimit','nativeFeeWei'].map(k=>[k,rows.reduce((sum,r)=>sum+BigInt(r[v][k]),0n).toString()]))]));
const lines=['# 两轮多价格桶复用：独立签名交易 gas 对比','',
'仅运行用户指定场景，各合约一个独立部署。未运行原6个场景或Foundry测试。节点为本地Monad/MonadTen、chainId 31337；每个角色独立签名，每笔交易独立区块，实际代理/Factory clone。','',
'每版共 '+reports.bitmap.transactions.length+' 笔交易（包括部署、入金、split），全部成功。下表仅比较指定的7笔挂单/吃单，不含准备交易或链下断言。完整准备成本也保留在各版逐笔回执中。','',
'## 场景与数量','',
'第一轮：maker A、B各按60、45、50、55的顺序批量挂2份YES卖单，maker C再在55挂2份。taker以orderInsert(60,18e6,0,true,true)全部买入，FIFO为45 A/B → 50 A/B → 55 A/B/C → 60 A/B。','',
'第二轮：maker A重复原4笔批量订单，maker C在55挂2份；taker以orderInsert(60,10e6,0,true,true)全部买入。累计18+10=28份，非5份。第二轮55有两笔订单，head与tail不同；只有其他三个单节点桶满足head=tail。','',
'复用现有runner角色：用户maker A/B/C/taker分别对应签名角色B/C/D/E，部署owner仍为角色A，与maker A分开。实际地址见JSON scenarios[0].actors。四名交易者各入金100 USDC，三名maker各split 20对；场景结束保持未结算状态。','',
'## 逐笔对比','',
'| 操作 | bitmap gasUsed | bitmapLink gasUsed | Link变化 | bitmap gasLimit | Link gasLimit | bitmap MON实扣 | Link MON实扣 |','|---|---:|---:|---:|---:|---:|---:|---:|'];
for(const r of rows){const a=r.bitmap,b=r.bitmapLink;lines.push(`| ${r.label} | ${Number(a.gasUsed).toLocaleString('en-US')} | ${Number(b.gasUsed).toLocaleString('en-US')} | ${((Number(b.gasUsed)/Number(a.gasUsed)-1)*100).toFixed(2)}% | ${a.gasLimit} | ${b.gasLimit} | ${mon(a.nativeFeeWei)} | ${mon(b.nativeFeeWei)} |`);}
lines.push(`| **7笔合计** | **${totals.bitmap.gasUsed}** | **${totals.bitmapLink.gasUsed}** | **${((Number(totals.bitmapLink.gasUsed)/Number(totals.bitmap.gasUsed)-1)*100).toFixed(2)}%** | ${totals.bitmap.gasLimit} | ${totals.bitmapLink.gasLimit} | ${mon(totals.bitmap.nativeFeeWei)} | ${mon(totals.bitmapLink.nativeFeeWei)} |`);
lines.push('','gasUsed来自交易receipt，未计入只读断言的成本。legacy交易固定102 gwei，正常gasLimit=floor(estimateGas×1.2)。实际MON实扣逐笔核对为gasLimit×effectiveGasPrice，不是gasUsed×price；本地节点结果不代表线上拥堵或主网报价。','',
'## 节点与资金验证','',
'- 链表第一轮45/50/60活动链[1,2]、55活动链[1,2,3]；清空后head均为0，freeList分别为[2,1]和[3,2,1]。',
'- 链表第二轮45/50/60活动链[2]、55活动链[3,2]，freeList均剩[1]，底层数组长度不增长。再次清空后freeList分别为[2,1]和[2,3,1]。空桶tail允许保留旧值。',
'- 数组版第一轮对应索引[0,1]/[0,1,2]；清空后数组长度和head为0；第二轮重建为[0]/[0,1]，再次全部删除。',
'- 四个阶段的head/tail/freeList、节点数量、节点内容写入JSON checkpoints，同时检查链无环、active/free互斥、所有节点可达、bitmap与有效订单匹配。',
'- 每笔操作核对所有参与者账本及TradeInfo的maker、价格、数量、费用、方向和精确节点索引。',
'- 最终taker持有28 YES，余额85.131 USDC；总本金14.8，taker手续费0.069，maker返佣0.0345，平台费0.0345。尚未结算的抵押为60 USDC，所有订单均已吃完。','',
'## 文件与复现','',
'- [bitmap逐笔报告](bitmap-bucket-reuse-receipts/README.md)、[CSV](bitmap-bucket-reuse-receipts/receipts.csv)、[JSON证据](bitmap-bucket-reuse-receipts/receipts.json)。',
'- [bitmapLink逐笔报告](bitmapLink-bucket-reuse-receipts/README.md)、[CSV](bitmapLink-bucket-reuse-receipts/receipts.csv)、[JSON证据](bitmapLink-bucket-reuse-receipts/receipts.json)。',
'- [对比JSON](bitmap-bucket-reuse-independent-gas.json)。源码SHA-256、编译器与节点版本见各JSON metadata。','',
'```bash','cd foundry','node script/bitmap/run_receipt_scenarios.cjs bitmap bucket-reuse','node script/bitmap/run_receipt_scenarios.cjs bitmapLink bucket-reuse','node script/bitmap/report_bucket_reuse.cjs','```');
fs.writeFileSync(path.join(root,'docs/bitmap-bucket-reuse-independent-gas.md'),lines.join('\n')+'\n');
fs.writeFileSync(path.join(root,'docs/bitmap-bucket-reuse-independent-gas.json'),JSON.stringify({rows,totals,metadata:Object.fromEntries(variants.map(v=>[v,reports[v].metadata]))},null,2)+'\n');
console.log(JSON.stringify(totals));
