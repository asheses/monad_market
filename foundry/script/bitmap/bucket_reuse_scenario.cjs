// Explicit reference orders/indices for the user's two-round, four-price scenario.
const assert = require('node:assert/strict');
module.exports = async function(c) {
  const {linked,setup,split,send,check,checkBooks,trade,order,qty,addr,low,artifacts,scenarios}=c;
  // Keep the shared runner's owner A distinct from the requested maker A.
  const actors={makerA:'B',makerB:'C',makerC:'D',taker:'E'};
  const env=await setup('bucket-reuse-YES',{B:100,C:100,D:100,E:100});
  env.actorAliases=actors;
  for(const who of ['B','C','D'])await split(env,who,20);
  const prices=[60,45,50,55],batch=prices.map(p=>order(p,2,false,true));
  const checkpoints=[];
  async function post(who,orders,indices,single,phase){
    const args=single?[55,qty(2),0n,false,true]:[orders];
    await send(env,who,env.market,artifacts.market,single?'orderInsert':'orderBatchInsert',args,{result:phase});
    env.last.phase=phase;
    const emitted=env.last.events.filter(e=>low(e.address)===low(env.market)&&e.eventName==='OrderInsertInfo');
    assert.equal(emitted.length,orders.length);
    for(const [i,b] of orders.entries()){
      assert.equal(BigInt(emitted[i].args.index),BigInt(linked?indices[i]:indices[i]+1),'exact inserted node/index');
      const o={who,p:b.prices,q:b.shareAmounts,expiry:0n,version:0,buy:false,yes:true};
      Object.defineProperty(o,'index',{value:indices[i]});env.orders.push(o);
      env.expected[who].yes-=o.q;env.expected[who].yl+=o.q;
    }
    await check(env);
  }
  async function snapshot(stage,activeByPrice,freeByPrice){
    const buckets=(await checkBooks(env)).filter(b=>b.yes&&prices.includes(b.p));
    const evidence=[];
    for(const b of buckets){
      const active=activeByPrice[b.p],free=freeByPrice[b.p];
      if(linked){
        const list=start=>{const out=[];while(start){assert.ok(out.length<b.length);out.push(start);start=Number(b.nodes[start].y>>96n);}return out;};
        assert.deepEqual(list(b.head),active,`${stage} @${b.p} active nodes`);
        assert.deepEqual(list(b.free),free,`${stage} @${b.p} free nodes`);
        assert.equal(b.length,b.p===55?4:3,'node array never grows in round two');
        if(active.length)assert.equal(b.tail,active.at(-1),'tail follows FIFO, not numeric index');
      }else{
        assert.equal(b.head,0,'array starts at zero or is fully deleted');
        assert.equal(b.length,active.length,'array is recreated after full deletion');
      }
      evidence.push({price:b.p,length:b.length,head:b.head,...(linked?{tail:b.tail,freeList:b.free}:{}),activeIndices:active,freeIndices:linked?free:[],nodes:b.nodes});
    }
    checkpoints.push({stage,receiptIndex:env.last.index,buckets:evidence});
    env.last.bucketCheckpoint=checkpoints.at(-1);
  }
  await post('B',batch,linked?[1,1,1,1]:[0,0,0,0],false,'round1-makerA-batch');
  await post('C',batch,linked?[2,2,2,2]:[1,1,1,1],false,'round1-makerB-batch');
  await post('D',[order(55,2,false,true)],linked?[3]:[2],true,'round1-makerC-single');
  const active1=Object.fromEntries(prices.map(p=>[p,p===55?(linked?[1,2,3]:[0,1,2]):(linked?[1,2]:[0,1])]));
  const empty=Object.fromEntries(prices.map(p=>[p,[]]));
  await snapshot('round1-posted',active1,empty);
  // Explicit FIFO: 45 A/B, 50 A/B, 55 A/B/C, 60 A/B. Fees are raw USDC units per 2-share fill.
  await trade(env,'E','orderInsert',[60,qty(18),0n,true,true],
    [[1,qty(2),4950n],[5,qty(2),4950n],[2,qty(2),5000n],[6,qty(2),5000n],
     [3,qty(2),4950n],[7,qty(2),4950n],[8,qty(2),4950n],[0,qty(2),4800n],[4,qty(2),4800n]],
    'round1-taker-buy18');env.last.phase='round1-taker-buy18';
  assert.equal(env.expected.E.yes,qty(18));assert.equal(env.expected.E.cash,90455650n);
  const free1=Object.fromEntries(prices.map(p=>[p,p===55?[3,2,1]:[2,1]]));
  await snapshot('round1-drained',empty,free1);
  await post('B',batch,linked?[2,2,2,3]:[0,0,0,0],false,'round2-makerA-batch');
  await post('D',[order(55,2,false,true)],linked?[2]:[1],true,'round2-makerC-single');
  const active2=Object.fromEntries(prices.map(p=>[p,p===55?(linked?[3,2]:[0,1]):(linked?[2]:[0])]));
  const free2=Object.fromEntries(prices.map(p=>[p,[1]]));
  await snapshot('round2-posted',active2,free2);
  await trade(env,'E','orderInsert',[60,qty(10),0n,true,true],
    [[10,qty(2),4950n],[11,qty(2),5000n],[12,qty(2),4950n],[13,qty(2),4950n],[9,qty(2),4800n]],
    'round2-taker-buy10');env.last.phase='round2-taker-buy10';
  assert.equal(env.expected.E.yes,qty(28),'18 + 10 = 28 shares');
  assert.equal(env.expected.E.cash,85131000n,'14.8 principal + 0.069 total taker fee');
  assert.equal(env.fees,34500n,'platform fees');
  const freeFinal=Object.fromEntries(prices.map(p=>[p,p===55?[2,3,1]:[2,1]]));
  await snapshot('round2-drained',empty,freeFinal);
  scenarios.push({name:env.name,market:env.market,vault:env.vault,token:env.token,
    actors:Object.fromEntries(Object.entries(actors).map(([name,role])=>[name,{role,address:addr(role)}])),
    finalAccounts:env.expected,checkpoints,backing:env.backing,platformFees:env.fees,
    takerShares:qty(28),takerPrincipal:14800000n,takerFees:69000n,
    checks:'two rounds, exact FIFO/index/fees, full ledger, drained books, reclaimed nodes; no settlement requested'});
  console.log(`${env.name}: PASSED; 18 + 10 shares, both rounds drained, ${linked?'node reuse':'bucket recreation'} verified`);
};
