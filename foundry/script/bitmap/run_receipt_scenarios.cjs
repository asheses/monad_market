#!/usr/bin/env node
// Real signed transactions on a private, automatically managed Monad Anvil node.
// Run from foundry/: node script/bitmap/run_receipt_scenarios.cjs
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const {createRequire} = require('node:module');
const ROOT = path.resolve(__dirname, '../..');
const variant = process.argv[2] || 'bitmap';
assert.ok(['bitmap', 'bitmapLink'].includes(variant), 'usage: node run_receipt_scenarios.cjs [bitmap|bitmapLink]');
const selection = process.argv[3] || 'all';
assert.ok(['all','bucket-reuse'].includes(selection), 'scenario must be all or bucket-reuse');
const linked = variant === 'bitmapLink';
const reportDir = `docs/${variant}${selection==='bucket-reuse'?'-bucket-reuse':''}-receipts`;
const failures = [];
const inspectArtifact = name => JSON.parse(execFileSync('forge', ['inspect', `src/${variant}/${name}.sol:${name}`, 'artifact', '--json'], {cwd:ROOT, encoding:'utf8', maxBuffer:20*1024*1024}));
const deps = createRequire(path.resolve(ROOT, '../monad_market_next/package.json'));
const {encodeFunctionData, encodeDeployData, decodeFunctionResult, decodeEventLog,
  decodeErrorResult, encodeAbiParameters, keccak256, toHex} = deps('viem');
const {mnemonicToAccount} = deps('viem/accounts');
const U = 1000000n;
const roles = ['A','O','B','C','D','E','F','G','H','I'];
const traders = roles.slice(2);
// Public Anvil development mnemonic, never production accounts.
const accounts = Object.fromEntries(roles.map((r,i) => [r,mnemonicToAccount(
  'test test test test test test test test test test test junk', {addressIndex:i})]));
const addr = r => accounts[r].address;
const low = x => x.toLowerCase();
const json = x => JSON.stringify(x, (_,v) => typeof v === 'bigint' ? v.toString() : v);
const pretty = x => JSON.stringify(x, (_,v) => typeof v === 'bigint' ? v.toString() : v, 2);
const qty = x => BigInt(x)*U;
const units = x => { x=BigInt(x);return `${x/U}.${(x%U).toString().padStart(6,'0')}`; };
const artifact = (file,name) => JSON.parse(fs.readFileSync(path.join(ROOT,'out',file,`${name}.json`)));
let rpcUrl, child, serial=0, clock=1800000000, lastBlock=0n;
const rows=[], scenarios=[];
let artifacts, layout;
const pause = ms => new Promise(r=>setTimeout(r,ms));
async function rpc(method,params=[]) {
  const r = await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:json({jsonrpc:'2.0',id:++serial,method,params})});
  const d=await r.json(); if(d.error) throw Error(`${method}: ${json(d.error)}`); return d.result;
}
async function batchRPC(requests) {
  const req=requests.map(([method,params])=>({jsonrpc:'2.0',id:++serial,method,params}));
  const r=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:json(req)});
  const data=await r.json(); assert.ok(Array.isArray(data),json(data));
  const byId=new Map(data.map(x=>[x.id,x]));
  return req.map(x=>{const d=byId.get(x.id);assert.ok(d && !d.error,json(d));return d.result;});
}
async function read(target,art,fn,args=[]) {
  return decodeFunctionResult({abi:art.abi,functionName:fn,data:await rpc('eth_call',[
    {to:target,data:encodeFunctionData({abi:art.abi,functionName:fn,args})},'latest'])});
}
function decodedLogs(receipt) {
  return receipt.logs.flatMap(log=>{
    for(const art of [artifacts.market,artifacts.vault,artifacts.factory,artifacts.token]) {
      try {return [{address:log.address,...decodeEventLog({abi:art.abi,data:log.data,topics:log.topics})}];} catch {}
    }
    return [];
  });
}
async function send(env,who,target,art,fn,args=[],options={}) {
  const data=fn==='constructor' ? encodeDeployData({abi:art.abi,bytecode:art.bytecode.object,args})
    : encodeFunctionData({abi:art.abi,functionName:fn,args});
  if(options.at!==undefined) clock=Math.max(clock+1,options.at);else clock++;
  await rpc('evm_setNextBlockTimestamp',[clock]);
  const before=BigInt(await rpc('eth_getBalance',[addr(who),'latest']));
  const nonce=Number(BigInt(await rpc('eth_getTransactionCount',[addr(who),'latest'])));
  const transaction={from:addr(who),...(target?{to:target}:{}),data,gasPrice:toHex(102000000000n),value:'0x0'};
  // Reverting transactions bypass estimateGas so that they really enter a block.
  let estimate=null,estimateFailure;
  if(!options.revert)try{estimate=BigInt(await rpc('eth_estimateGas',[transaction]));}catch(e){estimateFailure=e.message;}
  const gas=options.revert ? options.gasLimit : estimate===null ? 1000000n : estimate*120n/100n;
  const beforeProof=target===env.market ? await proofState(env) : null;
  assert.ok(gas>0n, "explicit gas limit for mined revert");
  const raw=await accounts[who].signTransaction({...(target?{to:target}:{}),data,
    gas,gasPrice:102000000000n,nonce,chainId:31337,type:'legacy',value:0n});
  const hash=await rpc('eth_sendRawTransaction',[raw]);
  let receipt;
  for(let i=0;i<100;i++){receipt=await rpc('eth_getTransactionReceipt',[hash]);if(receipt)break;await pause(50);}
  assert.ok(receipt,`missing receipt ${hash}`);
  const block=await rpc('eth_getBlockByHash',[receipt.blockHash,false]);
  assert.equal(block.transactions.length,1,'one independent transaction per block');
  assert.ok(BigInt(block.number)>lastBlock,'fresh mined block');lastBlock=BigInt(block.number);
  const after=BigInt(await rpc('eth_getBalance',[addr(who),'latest']));
  const nativeFee=gas*BigInt(receipt.effectiveGasPrice);
  assert.equal(before-after,nativeFee,'Monad sender native fee equals gasLimit * effectiveGasPrice');
  assert.equal(BigInt(await rpc('eth_getTransactionCount',[addr(who),'latest'])),BigInt(nonce+1),'nonce advances even on revert');
  let revertReason;
  const row={scenario:env.name,index:rows.length+1,actor:who,from:addr(who),to:target||null,
    method:fn,args,data,transactionHash:hash,blockNumber:BigInt(receipt.blockNumber),timestamp:BigInt(block.timestamp),
    nonce,status:BigInt(receipt.status),gasLimitPolicy:estimateFailure?'diagnostic-estimate-failed-fixed-1000000':options.gasLimitPolicy||'estimate-plus-20-percent',gasLimit:gas,estimateGas:estimate,gasUsed:BigInt(receipt.gasUsed),
    effectiveGasPrice:BigInt(receipt.effectiveGasPrice),nativeFeeWei:nativeFee,nativeBalanceBefore:before,
    nativeBalanceAfter:after,revertReason,result:options.result||'',receipt,estimateFailure,quoteFailure:env.quoteFailure,events:decodedLogs(receipt)};
  rows.push(row);env.last=row;
  if(BigInt(receipt.status)===0n){
    const afterProof=beforeProof ? await proofState(env) : null;
    if(beforeProof){row.rollbackProof={before:beforeProof,after:afterProof};assert.deepEqual(afterProof,beforeProof,'failed call storage unchanged');}
    row.failureTrace=await rpc('debug_traceTransaction',[hash,{tracer:'callTracer'}]);
  }
  assert.equal(BigInt(receipt.status),options.revert?0n:1n,`${env.name} ${who}.${fn}: unexpected receipt status; trace=${row.failureTrace?.error}; estimate=${estimateFailure}`);
  if(options.revert){
    assert.equal(receipt.logs.length,0,'reverted events are not persisted');
    const trace=row.failureTrace;
    row.failureTrace=trace;
    assert.ok(trace.output && trace.output!=='0x',`expected ${options.revert}, got empty revert data (${trace.error}); possible out-of-gas`);
    const err=decodeErrorResult({abi:[{type:'error',name:'Error',inputs:[{name:'message',type:'string'}]}],data:trace.output});
    revertReason=err.args[0];row.revertReason=revertReason;assert.equal(revertReason,options.revert,'actual mined revert reason');
  }
  if(process.env.RECEIPT_GAS_TRACE==='1' && selection==='bucket-reuse' && fn==='orderInsert' && args[3]===true){
    const trace=await rpc('debug_traceTransaction',[hash,{disableMemory:true,disableStorage:true}]);
    assert.ok(trace.structLogs.length,'opcode tracing requires --steps-tracing');
    const opcodes={},stores=[];
    for(const step of trace.structLogs){
      const stat=opcodes[step.op] ||= {count:0,gasCost:0};stat.count++;stat.gasCost+=Number(step.gasCost);
      if(step.op==='SSTORE')stores.push({depth:step.depth,pc:step.pc,slot:step.stack.at(-1),value:step.stack.at(-2),gasCost:step.gasCost});
    }
    row.gasProfile={opcodes,stores,traceGas:trace.gas,failed:trace.failed};
    const dir=path.join(ROOT,reportDir);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,`gas-trace-${row.index}.json`),pretty(trace)+'\n');
  }
  return row;
}
const freshAccount=()=>({cash:0n,wallet:0n,deposit:0n,yes:0n,yl:0n,no:0n,nl:0n,version:0});
async function deploy(env,art,args,label){
  const row=await send(env,'A',null,art,'constructor',args,{result:label});
  assert.ok(row.receipt.contractAddress);
  assert.notEqual(await rpc('eth_getCode',[row.receipt.contractAddress,'latest']),'0x');
  row.verified=true;row.result+=` -> ${row.receipt.contractAddress}`;return row.receipt.contractAddress;
}
async function setup(name,funding) {
  const env={name,expected:Object.fromEntries(traders.map(r=>[r,freshAccount()])),orders:[],fills:[],orderIndices:{},
    backing:0n,fees:0n,collected:0n,withdrawn:0n,supply:0n,state:0};
  env.token=await deploy(env,artifacts.token,[],'deploy six-decimal mock USDC');
  const vi=await deploy(env,artifacts.vault,[],'deploy Vault implementation');
  env.vault=await deploy(env,artifacts.proxy,[vi,encodeFunctionData({abi:artifacts.vault.abi,functionName:'initialize',args:[env.token]})],'deploy+initialize Vault proxy');
  assert.equal(low(await read(env.vault,artifacts.vault,'owner')),low(addr('A')));
  assert.equal(low(await read(env.vault,artifacts.vault,'USDCAddress')),low(env.token));
  const fi=await deploy(env,artifacts.factory,[],'deploy Factory implementation');
  env.factory=await deploy(env,artifacts.proxy,[fi,encodeFunctionData({abi:artifacts.factory.abi,functionName:'initialize'})],'deploy+initialize Factory proxy');
  assert.equal(low(await read(env.factory,artifacts.factory,'owner')),low(addr('A')));
  await send(env,'A',env.vault,artifacts.vault,'setMarketFactory',[env.factory]);
  assert.equal(low(await read(env.vault,artifacts.vault,'marketFactory')),low(env.factory));
  env.last.result='Vault factory wired';env.last.verified=true;
  await send(env,'A',env.factory,artifacts.factory,'setVault',[env.vault]);
  assert.equal(low(await read(env.factory,artifacts.factory,'vault')),low(env.vault));env.last.result='Factory vault wired';env.last.verified=true;
  const created=await send(env,'A',env.factory,artifacts.factory,'createMarket',[addr('O'),100n,5000n]);
  env.market=created.events.find(x=>x.eventName==='CreateMarket').args.market;
  assert.equal(await read(env.vault,artifacts.vault,'markets',[env.market]),true);
  assert.equal(low(await read(env.market,artifacts.market,'oracle')),low(addr('O')));
  assert.equal(low(await read(env.market,artifacts.market,'vault')),low(env.vault));
  assert.equal(await read(env.market,artifacts.market,'takerFeeRate'),100n);
  assert.equal(await read(env.market,artifacts.market,'makerRebateRate'),5000n);
  assert.equal(await read(env.token,artifacts.token,'decimals'),6);
  env.last.result=`created registered market ${env.market}`;
  await check(env);
  for(const [r,whole] of Object.entries(funding)) {
    const q=qty(whole);
    await send(env,'A',env.token,artifacts.token,'mint',[addr(r),q],{result:`fixture mint ${r} ${whole} USDC`});
    env.expected[r].wallet+=q;env.supply+=q;await check(env);
    await send(env,r,env.token,artifacts.token,'approve',[env.vault,q],{result:`approve ${whole} USDC`});
    assert.equal(await read(env.token,artifacts.token,'allowance',[addr(r),env.vault]),q);await check(env);
    await send(env,r,env.vault,artifacts.vault,'deposit',[q],{result:`wallet -${whole}, Vault available +${whole}`});
    env.expected[r].wallet-=q;env.expected[r].cash+=q;
    assert.equal(await read(env.token,artifacts.token,'allowance',[addr(r),env.vault]),0n);await check(env);
  }
  console.log(`${name}: deployed and funded with separately signed transactions`);
  return env;
}
async function proofState(env) {
  const proofs=await Promise.all([env.market,env.vault,env.token].map(a=>rpc('eth_getProof',[a,[],'latest'])));
  return proofs.map(p=>({address:p.address,storageHash:p.storageHash,codeHash:p.codeHash,balance:p.balance,nonce:p.nonce}));
}
async function revertTx(env,who,fn,args,reason='Insufficient output amount'){
  const before=await proofState(env);
  let gasLimit, gasLimitPolicy;
  if(fn==='buyUSDCAmount'||fn==='sellShares') {
    // Quote the same path with a permissive min output, then send the real,
    // stricter order. The failed call itself is never simulated instead of sent.
    const quoteArgs=[...args];quoteArgs[2]=0n;
    const data=encodeFunctionData({abi:artifacts.market.abi,functionName:fn,args:quoteArgs});
    try {
      gasLimit=BigInt(await rpc('eth_estimateGas',[{from:addr(who),to:env.market,data,gasPrice:toHex(102000000000n)}]))*120n/100n;
      gasLimitPolicy='same-path-min-output-zero-estimate-plus-20-percent';
    } catch(e) {
      // Diagnostic only: mine the broken route, retain its trace, and let the
      // original exact-revert assertion fail. Never count OOG as a passing revert.
      gasLimit=1000000n;gasLimitPolicy='diagnostic-estimate-failed-fixed-1000000';
      env.quoteFailure=e.message;
    }
  } else {
    const previous=rows.findLast(r=>r.scenario===env.name&&r.actor===who&&r.method===fn&&r.status===1n);
    assert.ok(previous,'retry uses prior successful transaction gas limit');
    gasLimit=previous.gasLimit;gasLimitPolicy='reuse-prior-successful-call-limit';
  }
  await send(env,who,env.market,artifacts.market,fn,args,{revert:reason,gasLimit,gasLimitPolicy,result:`REVERT: ${reason}; all 3 contract storage roots unchanged; native gas paid`});
  const after=await proofState(env);assert.deepEqual(after,before,'full contract storage roots roll back');
  env.last.rollbackProof={before,after};await check(env);
}
async function check(env) {
  if(!env.market)return;
  const expected=env.expected;
  const values=await Promise.all(traders.map(async r=>{
    const [cash,wallet,info]=await Promise.all([read(env.vault,artifacts.vault,'balances',[addr(r)]),
      read(env.token,artifacts.token,'balanceOf',[addr(r)]),read(env.market,artifacts.market,'traderInfos',[addr(r)])]);
    const e=expected[r];assert.equal(cash,e.cash,`${env.name} ${r} cash after ${env.last.method}`);
    assert.equal(wallet,e.wallet,`${r} wallet`);
    assert.deepEqual(info,[e.deposit,e.yes,e.yl,e.no,e.nl],`${env.name} ${r} shares/deposit after ${env.last.method}`);
    const slot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[addr(r),layout.versions]));
    assert.equal(BigInt(await rpc('eth_getStorageAt',[env.market,slot,'latest'])),BigInt(e.version));
    return {actor:r,cash,wallet,deposit:info[0],yes:info[1],yesLocked:info[2],no:info[3],noLocked:info[4]};
  }));
  const [actualCash,fees,collected,state,ownerWallet,supply]=await Promise.all([
    read(env.token,artifacts.token,'balanceOf',[env.vault]),read(env.market,artifacts.market,'marketFeeReceived'),
    read(env.vault,artifacts.vault,'totalMarketFeeReceived'),read(env.market,artifacts.market,'marketState'),
    read(env.token,artifacts.token,'balanceOf',[addr('A')]),read(env.token,artifacts.token,'totalSupply')]);
  assert.equal(fees,env.fees);assert.equal(collected,env.collected);assert.equal(state,env.state);
  assert.equal(ownerWallet,env.withdrawn);assert.equal(supply,env.supply);
  const all=Object.values(expected),sum=fn=>all.reduce((n,e)=>n+fn(e),0n);
  assert.equal(actualCash,sum(e=>e.cash+e.deposit)+env.backing+env.fees+env.collected,'Vault solvency');
  assert.equal(actualCash+sum(e=>e.wallet)+env.withdrawn,env.supply,'USDC conserved');
  if(env.state===0||env.state===3){
    assert.equal(sum(e=>e.yes+e.yl),env.backing);assert.equal(sum(e=>e.no+e.nl),env.backing);
    await checkBooks(env);
  }else assert.equal(sum(e=>env.state===1?e.yes+e.yl:e.no+e.nl),env.backing,'unredeemed winners');
  const fills=env.last.events.filter(e=>low(e.address)===low(env.market)&&e.eventName==='TradeInfo').map(e=>e.args);
  assert.deepEqual(fills,env.fills,'exact FIFO maker, price, quantity and fees');env.fills=[];
  env.last.accountsAfter=values;
  env.last.accountingAfter={actualCash,backing:env.backing,fees,collected,state,supply};
  env.last.verified=true;
}
async function checkBooks(env){
  const buckets=[];
  for(const yes of [true,false])for(let p=1;p<100;p++)buckets.push({yes,p,slot:(yes?layout.yes:layout.no)+BigInt(p)*2n});
  const headers=await batchRPC(buckets.flatMap(b=>[b.slot,b.slot+1n].map(slot=>['eth_getStorageAt',[env.market,toHex(slot),'latest']])));
  const requests=[],locations=[];
  for(let i=0;i<buckets.length;i++){
    const b=buckets[i];b.length=Number(BigInt(headers[i*2]));
    const header=BigInt(headers[i*2+1]);
    b.head=Number(linked ? header & 0xffffffffn : header);
    b.tail=Number((header>>32n)&0xffffffffn);b.free=Number((header>>64n)&0xffffffffn);
    assert.ok(b.head<=b.length);assert.ok(b.length<100,'unexpected layout/length');
    const base=BigInt(keccak256(encodeAbiParameters([{type:'uint256'}],[b.slot])));
    for(let j=0;j<b.length;j++) {locations.push([b,j]);for(const off of [0n,1n]) requests.push(['eth_getStorageAt',[env.market,toHex(base+BigInt(j)*2n+off),'latest']]);}
  }
  const raw=requests.length?await batchRPC(requests):[];
  for(const b of buckets){b.live=[];b.nodes=[];}
  for(let i=0;i<locations.length;i++){
    const [b,j]=locations[i],x=BigInt(raw[i*2]),y=BigInt(raw[i*2+1]);
    const owner=toHex(x&((1n<<160n)-1n),{size:20}),
      q=linked ? y&((1n<<96n)-1n) : x>>160n,
      ver=linked ? Number((x>>208n)&0xffffffffn) : Number((y>>48n)&0xffffffffn);
    b.nodes[j]={x,y};
    if(linked)continue;
    if(!q)continue;
    const role=traders.find(r=>low(addr(r))===low(owner));assert.ok(role,'known order owner');
    if(ver<env.expected[role].version)continue;
    assert.ok(j>=b.head,'live order not skipped by head');
    b.live.push({who:role,p:b.p,q,expiry:y&((1n<<48n)-1n),version:ver,buy:((y>>80n)&255n)!==0n,yes:b.yes});
  }
  if(linked) for(const b of buckets){
    const active=new Set(),free=new Set();let cursor=b.head,last=0;
    while(cursor){
      assert.ok(cursor<b.length, `linked head/next out of bounds @${b.p}`);
      assert.ok(!active.has(cursor), `linked active cycle @${b.p}`);active.add(cursor);last=cursor;
      const {x,y}=b.nodes[cursor],q=y&((1n<<96n)-1n);
      const owner=toHex(x&((1n<<160n)-1n),{size:20});
      const role=traders.find(r=>low(addr(r))===low(owner));
      const ver=Number((x>>208n)&0xffffffffn);
      if(q && role && ver>=env.expected[role].version)b.live.push({who:role,p:b.p,q,expiry:(x>>160n)&((1n<<48n)-1n),version:ver,buy:((x>>240n)&255n)!==0n,yes:b.yes});
      cursor=Number((y>>96n)&0xffffffffn);
    }
    // A stale tail is harmless when head is zero; insertion overwrites both.
    if(b.head!==0) assert.equal(b.tail,last,`linked tail must be last active node @${b.p}`);
    cursor=b.free;
    while(cursor){
      assert.ok(cursor<b.length,`free list out of bounds @${b.p}`);
      assert.ok(!free.has(cursor),`free list cycle @${b.p}`);
      assert.ok(!active.has(cursor),`active/free list overlap @${b.p} index=${cursor}`);
      free.add(cursor);const {x,y}=b.nodes[cursor];
      assert.equal(linked ? y&((1n<<96n)-1n) : x>>160n,0n,'free node quantity');
      cursor=Number((y>>96n)&0xffffffffn);
    }
    if(b.length)assert.equal(active.size+free.size,b.length-1,`all non-sentinel nodes accounted @${b.p}`);
  }
  for(const b of buckets){
    const expected=env.orders.filter(o=>o.yes===b.yes&&o.p===b.p&&o.q>0n);
    assert.deepEqual(b.live,expected,`${env.name} orderbook ${b.yes?'YES':'NO'}@${b.p}`);
  }
  for(const yes of [true,false]){
    const bitmap=buckets.filter(b=>b.yes===yes&&(linked?b.head:b.length)).reduce((m,b)=>m|(1n<<BigInt(b.p)),0n);
    assert.equal(await read(env.market,artifacts.market,yes?'yesBitmap':'noBitmap'),bitmap,'physical buckets/bitmap');
  }
  return buckets;
}
async function split(env,who,n,at){
  await send(env,who,env.market,artifacts.market,'splitUSDC',[qty(n)],{at,result:`split ${n} USDC -> ${n} YES + ${n} NO`});
  const e=env.expected[who];e.cash-=qty(n);e.yes+=qty(n);e.no+=qty(n);env.backing+=qty(n);await check(env);
}
function order(p,n,buy,yes,expiry=0n){return {prices:p,shareAmounts:qty(n),endTimestamps:BigInt(expiry),isBuy:buy,isYes:yes};}
async function insertBatch(env,who,batch,at){
  await send(env,who,env.market,artifacts.market,'orderBatchInsert',[batch],{at,result:`post ${batch.length} passive orders`});
  const inserted=env.last.events.filter(e=>low(e.address)===low(env.market)&&e.eventName==='OrderInsertInfo');
  assert.equal(inserted.length,batch.length,'all passive orders emitted');
  for(const [batchIndex,b] of batch.entries()){
    const key=`${b.isYes}:${b.prices}`;
    const index=env.orderIndices[key]||0;env.orderIndices[key]=index+1;
    assert.equal(BigInt(inserted[batchIndex].args.index),BigInt(index+1),'insertion event index');
    const o={who,p:b.prices,q:b.shareAmounts,expiry:b.endTimestamps,version:env.expected[who].version,buy:b.isBuy,yes:b.isYes};
    Object.defineProperty(o,"index",{value:linked?index+1:index});env.orders.push(o);
    const e=env.expected[who];
    if(o.buy){const value=o.q*BigInt(o.p)/100n;e.cash-=value;e.deposit+=value;}
    else if(o.yes){e.yes-=o.q;e.yl+=o.q;}else{e.no-=o.q;e.nl+=o.q;}
  }
  await check(env);
}
function fill(env,id,who,q,fee){
  const o=env.orders[id],m=env.expected[o.who],t=env.expected[who];
  const principal=q*BigInt(o.p)/100n,rebate=fee/2n;
  o.q-=q;env.fees+=fee-rebate;
  if(o.buy){m.deposit-=principal;m.cash+=rebate;t.cash+=principal-fee;if(o.yes){m.yes+=q;t.yes-=q;}else{m.no+=q;t.no-=q;}}
  else{m.cash+=principal+rebate;t.cash-=principal+fee;if(o.yes){m.yl-=q;t.yes+=q;}else{m.nl-=q;t.no+=q;}}
  env.fills.push({maker:addr(o.who),taker:addr(who),shareAmount:q,price:o.p,makerFeeAmount:rebate,marketFeeAmount:fee-rebate,isBuy:!o.buy,isYes:o.yes,index:linked?o.index:BigInt(o.index)});
}
function release(env,id){const o=env.orders[id],e=env.expected[o.who];
  if(o.buy){const v=o.q*BigInt(o.p)/100n;e.deposit-=v;e.cash+=v;}else if(o.yes){e.yl-=o.q;e.yes+=o.q;}else{e.nl-=o.q;e.no+=o.q;}o.q=0n;
}
async function merge(env,who,n,at){
  await send(env,who,env.market,artifacts.market,'mergeShares',[qty(n)],{at,result:`burn ${n} pairs, return ${n} USDC`});
  const e=env.expected[who];e.cash+=qty(n);e.yes-=qty(n);e.no-=qty(n);env.backing-=qty(n);await check(env);
}
async function trade(env,who,fn,args,fills,result,at,releaseIds=[]){
  await send(env,who,env.market,artifacts.market,fn,args,{at,result});
  for(const id of releaseIds)release(env,id);
  for(const [id,q,fee] of fills)fill(env,id,who,q,fee);await check(env);
}
async function settle(env,yes){
  await send(env,'O',env.market,artifacts.market,'setMarketState',[yes?1:2],{result:yes?'YES wins':'NO wins'});
  env.state=yes?1:2;await check(env);
  for(const who of (yes?traders:['I','C','E','B','H','D','G','F'])){
    const e=env.expected[who];if(!(e.deposit+e.yes+e.yl+e.no+e.nl))continue;
    const winning=yes?e.yes+e.yl:e.no+e.nl,payout=winning+e.deposit;
    await send(env,who,env.market,artifacts.market,'redeem',[],{result:`redeem ${units(payout)} USDC (winning ${units(winning)}, buy deposit ${units(e.deposit)})`});
    e.cash+=payout;env.backing-=winning;e.deposit=e.yes=e.yl=e.no=e.nl=0n;await check(env);
    await revertTx(env,who,'redeem',[],'No shares to redeem');
  }
  for(const who of traders){const e=env.expected[who];if(!e.cash)continue;
    const q=e.cash;await send(env,who,env.vault,artifacts.vault,'withdraw',[q],{result:`withdraw ${units(q)} USDC to wallet`});
    e.wallet+=q;e.cash=0n;await check(env);
  }
  for(let i=0;i<2;i++){
    await send(env,'A',env.vault,artifacts.vault,'getMarketFee',[env.market],{result:`collect ${units(env.fees)} platform fees`});
    env.collected+=env.fees;env.fees=0n;await check(env);
  }
  for(let i=0;i<2;i++){
    await send(env,'A',env.vault,artifacts.vault,'withDrawFee',[],{result:`owner withdraw ${units(env.collected)} USDC fees`});
    env.withdrawn+=env.collected;env.collected=0n;await check(env);
  }
  assert.equal(await read(env.token,artifacts.token,'balanceOf',[env.vault]),0n);
  scenarios.push({name:env.name,market:env.market,vault:env.vault,token:env.token,finalAccounts:env.expected,
    supply:env.supply,platformFees:env.withdrawn,checks:'per-call full ledger, all orders, receipt/native fee; final Vault empty'});
  console.log(`${env.name}: PASSED and fully settled`);
}
async function mainline(yes){
  const env=await setup(`mainline-${yes?'YES':'NO'}`,{B:2000,C:2000,D:1000,E:1500,F:1000,G:500,H:500,I:500});
  const t=clock+20;
  for(const [r,n] of [['B',800],['C',600],['F',400],['G',200],['H',100],['I',100]])await split(env,r,n);
  await insertBatch(env,'B',[order(55,100,false,true,t+600),order(55,120,false,true),order(60,200,false,true),order(45,150,false,false),order(50,100,false,false,t+900),order(45,100,true,true,t+600),order(40,200,true,true),order(35,100,true,false)],t+60);
  await insertBatch(env,'C',[order(55,80,false,true),order(58,150,false,true,t+1200),order(65,100,false,true),order(45,100,false,false),order(55,150,false,false),order(45,150,true,true),order(42,100,true,true),order(35,100,true,false,t+600),order(30,200,true,false)],t+90);
  await trade(env,'D','orderInsert',[55,qty(250),0n,true,true],[[0,qty(100),247500n],[1,qty(120),297000n],[8,qty(30),74250n]],'buy 250 YES; pay 138.118750',t+120);
  await trade(env,'E','orderInsert',[55,qty(400),0n,true,true],[[8,qty(50),123750n],[9,qty(150),365400n],[2,qty(200),480000n]],'buy 400 YES across 55/58/60; pay 235.469150',t+180);
  await trade(env,'F','sellShares',[qty(220),true,qty(98)],[[5,qty(100),247500n],[13,qty(120),297000n]],'sell 220 YES; receive 98.455500',t+240);
  await trade(env,'G','sellShares',[qty(150),false,qty(52)],[[7,qty(100),227500n],[15,qty(50),113750n]],'sell 150 NO; receive 52.158750',t+300);
  await trade(env,'H','orderInsert',[45,qty(200),0n,true,false],[[3,qty(150),371250n],[11,qty(50),123750n]],'buy 200 NO; pay 90.495000',t+360);
  await trade(env,'I','sellShares',[qty(100),false,qty(29)],[[16,qty(100),210000n]],'sell 100 NO; receive 29.790000; C expiry refund 17.5',t+601,[15]);
  await send(env,'B',env.market,artifacts.market,'deleteOrder',[40,linked?1n:0n,true],{at:t+660,result:'cancel bid, refund B 80 USDC'});release(env,6);await check(env);
  await trade(env,'D','orderInsert',[45,qty(100),0n,true,false],[[11,qty(50),123750n],[12,qty(50),123750n]],'buy 100 NO across 45/55; pay 50.247500; B unlock 100 expired NO',t+901,[4]);
  await send(env,'C',env.market,artifacts.market,'updateVersion',[],{at:t+1000,result:'version 1; refund 85.5 USDC; unlock 100 YES + 100 NO'});
  for(let i=0;i<env.orders.length;i++)if(env.orders[i].who==='C'&&env.orders[i].q)release(env,i);
  env.expected.C.version=1;await check(env);
  await insertBatch(env,'C',[order(70,60,false,true),order(25,80,true,false)],t+1020);
  for(const [r,n,off] of [['H',50,1080],['F',100,1090],['G',50,1100],['B',300,1110],['C',200,1120]])await merge(env,r,n,t+off);
  for(const [state,off] of [[3,1800],[0,1860]]){
    await send(env,'O',env.market,artifacts.market,'setMarketState',[state],{at:t+off,result:state?'pause':'resume'});env.state=state;await check(env);
  }
  const cash=[1729435375n,1682777700n,811633750n,1264530850n,798455500n,402158750n,359505000n,429790000n];
  traders.forEach((r,i)=>assert.equal(env.expected[r].cash,cash[i],'original mainline literal cash'));
  assert.equal(env.backing,qty(1500));assert.equal(env.fees,1713075n);
  clock=t+3599;await settle(env,yes);assert.equal(env.withdrawn,1713075n);
}
async function budget(yes){
  const env=await setup(`budget-${yes?'YES':'NO'}`,{B:1000,C:1000,D:1000});
  await split(env,'B',200);await split(env,'C',200);
  await insertBatch(env,'B',[order(40,100,false,yes)]);await insertBatch(env,'C',[order(50,100,false,yes)]);
  await revertTx(env,'D','buyUSDCAmount',[qty(90),yes,qty(200)]);
  await trade(env,'D','buyUSDCAmount',[qty(90),yes,qty(199)],[[0,qty(100),240000n],[1,99024875n,247562n]],
    'budget 90: buy 199.024875 across 40/50; spend 89.999999; leave 0.000001');
  assert.equal(env.expected.D.cash,910000001n);assert.equal(env.orders[1].q,975125n);assert.equal(env.fees,243781n);
  await trade(env,'D','buyUSDCAmount',[qty(10),yes,975125n],[[1,975125n,2437n]],
    'depth exhausted: buy remaining 0.975125; spend 0.489999 of 10; keep 9.510001');
  await revertTx(env,'D','buyUSDCAmount',[qty(10),yes,U]);
  await settle(env,yes);
}
async function crossSell(yes){
  const env=await setup(`cross-sell-${yes?'YES':'NO'}`,{B:1000,C:1000,F:1000});
  await split(env,'F',400);
  await insertBatch(env,'B',[order(45,100,true,yes),order(40,200,true,yes)]);
  await insertBatch(env,'C',[order(45,150,true,yes),order(42,100,true,yes)]);
  await revertTx(env,'F','sellShares',[qty(300),yes,qty(133)]);
  await trade(env,'F','sellShares',[qty(300),yes,qty(132)],[[0,qty(100),247500n],[2,qty(150),371250n],[3,qty(50),121800n]],
    'sell 300 across 45/42; principal 133.5; fee 0.740550; receive 132.759450');
  assert.equal(env.expected.F.cash,732759450n);assert.equal(env.orders[3].q,qty(50));
  await trade(env,'F','sellShares',[qty(100),yes,qty(40)],[[3,qty(50),121800n],[1,qty(50),120000n]],
    'sell final 100 across 42/40; receive 40.758200');
  await settle(env,yes);
}
function exportReports(metadata,error){
  const dir=path.join(ROOT,reportDir);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'receipts.json'),pretty({metadata,error:error?.message,failures,scenarios,transactions:rows})+'\n');
  const columns=['verified','index','scenario','actor','method','args','result','status','blockNumber','gasLimit','gasUsed','effectiveGasPrice','nativeFeeWei','transactionHash'];
  const csv=v=>'"'+String(typeof v==='object'?json(v):v??'').replaceAll('"','""')+'"';
  fs.writeFileSync(path.join(dir,'receipts.csv'),'\ufeff'+[columns.join(','),...rows.map(r=>columns.map(k=>csv(r[k])).join(','))].join('\n')+'\n');
  const text=[`# ${variant} 独立签名交易与真实 receipt gasUsed\n`,
    `执行环境：本地Anvil ${metadata.node?.network}/${metadata.node?.hardFork}，chainId=31337；不是Monad主网/测试网fork，也不代表线上拥堵或真实USDC部署成本。\n`,
    '每个角色使用独立测试私钥签名，通过eth_sendRawTransaction发送；一笔交易一个区块。未使用prank、impersonation、合约存储改写或交易间快照回退。evm_setNextBlockTimestamp只控制测试时间。mock USDC通过真实mint交易准备余额；初始原生币由本地节点提供。\n',
    'gasUsed直接读取每笔已上链（本地链）receipt的执行消耗；Monad按gasLimit收费，实际费用并非gasUsed×price。规则见[Monad官方文档](https://docs.monad.xyz/developer-essentials/gas-pricing)。每笔均断言发送人原生币减少=gasLimit×effectiveGasPrice、nonce增加1。报价固定102 gwei，节点初始base fee=100 gwei，成功交易gasLimit=estimateGas×1.2；最小输出失败用例先用minOut=0估算同一路径并加20%作为gasLimit，再提交实际严格minOut的交易；重复赎回沿用首次成功赎回的gasLimit。失败后核对revert原因，排除out-of-gas。\n',
    '下述为验证目标；FAILED场景在首个不符处停止，不代表已完成结算。每次业务调用后核对全部用户USDC/份额/锁款、订单队列与bitmap、手续费和全局守恒。失败交易核对Market、Vault、USDC三个合约的完整storageHash/codeHash/balance/nonce不变，receipt.status=0且无日志；用户原生币仍支付gas。完整主线场景最终结算、提款及提费后Vault清零；bucket-reuse仅执行指定的两轮交易，不结算，余额与份额继续保留在市场中。\n',
    `结果：${error?'FAILED: '+error.message:scenarios.length+'个场景全部通过'}；${rows.length}笔独立交易，其中${rows.filter(r=>r.status===0n).length}笔status=0（含异常失败，只有通过原因及回滚断言者算预期回滚）。\n`,
    '估算失败时额外用固定1,000,000 gasLimit发送诊断交易，记录真实失败receipt和trace；不把耗尽gas当作最小输出保护通过。该诊断策略不用于比较正常交易费用。\n',
    '完整原始receipt、calldata、账户核对快照、失败storageHash证据在receipts.json；CSV包含每筆输入、结果、gasUsed和交易hash。交易hash仅对本次本地链有效，脚本退出后节点停止。\n',
    ...failures.map(f=>`失败场景 ${f.scenario}：${f.message}（最后回执 #${f.lastReceipt}）。\n`),
    '## 逐笔调用\n','| # | 场景 | 用户 | 函数及原始参数 | 验证结果 | status | gasUsed | gasLimit（计费） | MON扣款 | 区块 |','|---:|---|---|---|---|---:|---:|---:|---:|---:|'];
  for(const r of rows)text.push(`| ${r.index} | ${r.scenario} | ${r.actor} | ${r.method}(${r.method==='constructor'?'见JSON初始化参数':json(r.args)}) | ${r.verified?r.result:'未完成验证：'+r.result} | ${r.status} | ${r.gasUsed.toLocaleString('en-US')} | ${r.gasLimit.toLocaleString('en-US')} | ${Number(r.nativeFeeWei)/1e18} | ${r.blockNumber} |`);
  text.push('\n## 复现\n','```bash','cd foundry',`node script/bitmap/run_receipt_scenarios.cjs ${variant}${selection==='all'?'':' '+selection}`,'```','\n脚本先forge build，再启动独占的127.0.0.1临时端口Monad Anvil；完成后停止节点。使用相邻monad_market_next项目已安装的viem库。');
  fs.writeFileSync(path.join(dir,'README.md'),text.join('\n')+'\n');
}
async function run(){
  execFileSync('forge',['build'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
  artifacts={token:artifact('BitmapMarketScenario.t.sol','ScenarioUSDC'),market:inspectArtifact('Market'),vault:inspectArtifact('Vault'),factory:inspectArtifact('MarketFactory'),proxy:artifact('ERC1967Proxy.sol','ERC1967Proxy')};
  for(const name of ['Market','MarketVault','Vault','MarketFactory']){
    const file=`src/${variant}/${name}.sol`;
    assert.equal(artifacts.factory.metadata.sources[file].keccak256,keccak256(toHex(fs.readFileSync(path.join(ROOT,file),'utf8').replaceAll('\r\n','\n'))),'artifact/source mismatch: '+file);
  }
  const info=JSON.parse(execFileSync('forge',['inspect',`src/${variant}/Market.sol:Market`,'storage-layout','--json'],{cwd:ROOT,encoding:'utf8'}));
  const slot=n=>BigInt(info.storage.find(s=>s.label===n).slot);layout={yes:slot('yesOrderBook'),no:slot('noOrderBook'),versions:slot('traderVersions')};
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  rpcUrl=`http://127.0.0.1:${port}`;
  child=spawn('anvil',[...(process.env.RECEIPT_GAS_TRACE==='1'?['--steps-tracing']:[]),'--network','monad','--hardfork','monad:MonadTen','--host','127.0.0.1','--port',String(port),'--chain-id','31337','--timestamp',String(clock),'--base-fee','100000000000','--gas-price','102000000000','--quiet'],{stdio:['ignore','ignore','pipe']});
  let startup='';child.stderr.on('data',d=>startup+=d.toString());
  let node;for(let i=0;i<100;i++){try{node=await rpc('anvil_nodeInfo');break;}catch{if(child.exitCode!==null)throw Error(startup);await pause(100);}}
  assert.equal(node?.network,'monad');assert.equal(node?.hardFork,'MonadTen');
  const rpcAccounts=await rpc('eth_accounts');roles.forEach((r,i)=>assert.equal(low(addr(r)),low(rpcAccounts[i])));
  const metadata={variant,selection,executedAt:new Date().toISOString(),node,client:await rpc('web3_clientVersion'),compiler:artifacts.market.metadata.compiler,
    actorAddresses:Object.fromEntries(roles.map(r=>[r,addr(r)])),sourceHashes:Object.fromEntries(['Market','MarketVault','Vault','MarketFactory'].map(n=>`src/${variant}/${n}.sol`).map(f=>[f,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT,f))).digest('hex')])),transactionType:'legacy',gasPriceWei:'102000000000'};
  try{
    if(selection==='bucket-reuse') {
      await require('./bucket_reuse_scenario.cjs')({linked,setup,split,send,check,checkBooks,trade,order,qty,addr,low,artifacts,scenarios});
    } else for(const [name,scenario] of [['mainline',mainline],['budget',budget],['cross-sell',crossSell]])for(const side of [true,false]){
      try{await scenario(side);}catch(e){
        failures.push({scenario:`${name}-${side?'YES':'NO'}`,message:e.message,stack:e.stack,lastReceipt:rows.at(-1)?.index});
        console.error(`${variant} ${name}-${side?'YES':'NO'} FAILED: ${e.message}`);
      }
    }
    for(const [file,hash] of Object.entries(metadata.sourceHashes))assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex'),hash,'source changed during run: '+file);
    if(failures.length)throw Error(`${failures.length}/6 scenarios failed; see failures in receipts.json`);
    assert.equal(new Set(rows.map(r=>r.transactionHash)).size,rows.length);
    exportReports(metadata);console.log(`PASS: ${rows.length} independent transaction receipts; ${reportDir}/README.md`);
  }catch(e){exportReports(metadata,e);throw e;}
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{if(child)child.kill('SIGTERM');});
