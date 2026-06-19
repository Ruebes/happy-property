// Verifiziert die Engine-Portierung (src/lib/rechner.ts) bit-genau gegen den Original-Rechner.
// Ausfuehren: npx esbuild src/lib/rechner.ts --format=esm --outfile=/tmp/rechner.mjs && node scripts/verify-rechner.mjs
import { compute as port } from '/tmp/rechner.mjs'

// ── DOM-Stubs für das ORIGINAL compute ───────────────────────────────────────
let VALS = {}, RADIOS = {}, CHECKS = {}
let sdUnits = []
let ppVals = Array(10).fill(0)
const $ = (id) => ({ value: VALS[id] ?? '' })
const document = {
  querySelector: (sel) => { const m = sel.match(/name="([^"]+)"/); return m ? { value: RADIOS[m[1]] } : null },
  getElementById: (id) => ({ checked: !!CHECKS[id], value: VALS[id] ?? '' }),
}
function isShareDeal(){return document.querySelector('input[name="s-dealtype"]:checked').value==='share';}

// ── ORIGINAL-Helfer + compute (VERBATIM aus index.html) ──────────────────────
function cyTax(inc){
  const bands=[{c:19500,r:0},{c:28000,r:.2},{c:36300,r:.25},{c:60000,r:.3},{c:Infinity,r:.35}];
  let t2=0,rest=Math.max(0,inc),prev=0;
  for(const b of bands){const w=Math.min(rest,b.c-prev);if(w>0)t2+=w*b.r;rest-=w;prev=b.c;if(rest<=0)break;}
  return Math.round(t2);
}
function irrCalc(cfs){
  const npv=r=>cfs.reduce((v,c,i)=>v+c/Math.pow(1+r,i),0);
  let lo=-0.999,hi=5;
  if(npv(lo)*npv(hi)>0)return NaN;
  for(let i=0;i<120;i++){const m=(lo+hi)/2,v=npv(m);if(Math.abs(v)<1e-6)return m;if(v>0)lo=m;else hi=m;}
  return(lo+hi)/2;
}
function computeOrig(){
  const km=parseInt($('s-month').value,10)||8;
  const ky=parseInt($('s-year').value,10)||2025;
  const mF=Math.max(1,13-km);
  const mA=[mF].concat(Array(9).fill(12));
  const fA=mA.map(function(m){return m/12;});
  const yN=Array.from({length:10},function(_,i){return ky+i;});
  var sdMode=isShareDeal();
  var sdInputMode=sdMode?document.querySelector('input[name="sd-mode"]:checked').value:'';
  var pNetList,discountPct,discountAmt,pNet,pGrossList,pGross,vatAmt,costs,bedrooms;
  var sdVatDrawn=0,sdVatYears=0,sdVatClawback=0,sdNumUnits=0,sdTotalSqm=0,sdTotalTerr=0;
  if(sdMode){
    if(sdInputMode==='units'&&sdUnits.length>0){
      pNetList=sdUnits.reduce(function(a,u){return a+(u.price||0);},0);
      sdTotalSqm=sdUnits.reduce(function(a,u){return a+(u.sqm||0);},0);
      sdTotalTerr=sdUnits.reduce(function(a,u){return a+(u.terr||0);},0);
      sdNumUnits=sdUnits.length;bedrooms=0;
    } else {
      pNetList=Math.max(1,parseFloat($('sd-price').value)||1000000);
      sdTotalSqm=Math.max(20,parseFloat($('sd-sqm').value)||250);
      sdTotalTerr=Math.max(0,parseFloat($('sd-terr').value)||60);
      sdNumUnits=Math.max(1,parseInt($('sd-num').value,10)||3);bedrooms=0;
    }
    discountPct=Math.max(0,Math.min(30,parseFloat($('sd-discount').value)||0));
    discountAmt=Math.round(pNetList*discountPct/100);
    pNet=pNetList-discountAmt;pGrossList=pNetList;pGross=pNet;vatAmt=0;costs=0;
    sdVatDrawn=Math.max(0,parseFloat($('sd-vat-drawn').value)||0);
    sdVatYears=Math.max(0,Math.min(10,parseInt($('sd-vat-years').value,10)||0));
    sdVatClawback=sdVatYears>=10?0:Math.round(sdVatDrawn*(10-sdVatYears)/10);
  } else {
    pNetList=Math.max(1,parseFloat($('s-price').value)||250000);
    discountPct=Math.max(0,Math.min(30,parseFloat($('s-discount').value)||0));
    discountAmt=Math.round(pNetList*discountPct/100);
    pNet=pNetList-discountAmt;pGrossList=Math.round(pNetList*1.19);pGross=Math.round(pNet*1.19);
    vatAmt=pGross-pNet;costs=Math.round(pGross*0.01);bedrooms=parseInt($('s-bedrooms').value,10)||2;
  }
  const fin=document.querySelector('input[name="s-fin"]:checked').value;
  const letT=document.querySelector('input[name="s-let"]:checked').value;
  const mode=document.querySelector('input[name="s-mode"]:checked').value;
  const resCY=document.querySelector('input[name="s-res"]:checked').value==='cy';
  var hotelEl=document.getElementById(sdMode?'sd-hotel':'s-hotel');
  const hotelConcept=letT==='short'&&hotelEl?hotelEl.checked:false;
  let ekAbs=Math.max(0,parseFloat($(sdMode?'sd-equity':'s-equity').value)||(sdMode?200000:75000));
  if(ekAbs>pGross)ekAbs=pGross;
  const loan=fin==='no'?0:Math.max(0,Math.round(pGross-ekAbs));
  var ekCosts=costs+sdVatClawback;
  const ekStart=fin==='no'?pGross+ekCosts:Math.round(ekAbs+ekCosts);
  const cyBI=resCY?Math.max(0,parseFloat($('s-cyi').value)||0):0;
  const yPct=parseFloat($('s-yield').value)||5.5;
  const rG=parseFloat($('s-rg').value)||5;
  const mgP=parseFloat($('s-mgmt').value)||2;
  const iP=parseFloat($('s-int').value)||4.1;
  const termY=parseFloat($('s-term').value)||20;
  const amP=parseFloat($('s-amort').value)||2;
  const appP=parseFloat($('s-app').value)||5;
  const deTx=parseFloat($('s-det').value)||42;
  const furnCost=Math.max(0,parseFloat($('s-furn').value)||0);
  const furnFree=document.querySelector('input[name="furn-free"]:checked').value==='yes';
  const vatA=Array(10).fill(0);
  if(letT==='short'){var acc=0;for(var vi=0;vi<mA.length;vi++){acc+=mA[vi];if(acc>=24){vatA[vi]=vatAmt;break;}}}
  const baseR=pGrossList*(yPct/100);
  const rents=fA.map(function(f,i){return Math.round(baseR*Math.pow(1+rG/100,i)*f);});
  const mgmt=rents.map(function(r,i){return Math.round(r*(mgP/100)*Math.pow(1.02,i));});
  const iR=iP/100;
  var intC=[],princC=[],rateC=[],restL=[],prepayC=[];var rem=loan;
  if(fin==='no'||loan<=0){for(var y2=0;y2<10;y2++){intC.push(0);princC.push(0);rateC.push(0);restL.push(0);prepayC.push(0);}}
  else if(mode==='ann'){
    var payA=iR===0?Math.round(loan/Math.max(1,termY)):Math.round(loan*(iR*Math.pow(1+iR,termY))/(Math.pow(1+iR,termY)-1));
    for(var y3=0;y3<10;y3++){var f2=fA[y3];
      if(rem>0&&y3<termY){var z=Math.round(rem*iR*f2);var rP=Math.round(payA*f2),ti=Math.max(0,rP-z);
        if(ti>rem){ti=rem;rP=z+ti;}var pp=Math.max(0,Math.min(rem-ti,Math.round(ppVals[y3]*f2)));
        intC.push(z);princC.push(ti);rateC.push(rP);prepayC.push(pp);rem=Math.max(0,rem-ti-pp);restL.push(rem);}
      else {intC.push(0);princC.push(0);rateC.push(0);prepayC.push(0);restL.push(rem);}}
  } else {
    var pAnn=loan*(amP/100);
    for(var y4=0;y4<10;y4++){var f3=fA[y4];
      if(y4<termY&&rem>0){var z2=Math.round(rem*iR*f3),ti2=Math.min(rem,Math.round(pAnn*f3));
        var pp2=Math.max(0,Math.min(rem-ti2,Math.round(ppVals[y4]*f3)));
        intC.push(z2);princC.push(ti2);rateC.push(z2+ti2);prepayC.push(pp2);rem=Math.max(0,rem-ti2-pp2);restL.push(rem);}
      else {intC.push(0);princC.push(0);rateC.push(0);prepayC.push(0);restL.push(rem);}}
  }
  const dCY=Math.round(pGross*0.8*0.03);
  var furnAfaAnn=(!furnFree && furnCost>0)?Math.round(furnCost/5):0;
  var sdTaxRateRaw=parseFloat($('sd-tax-rate').value);
  var sdTaxRate=sdMode?Math.max(0,Math.min(35,isNaN(sdTaxRateRaw)?12.5:sdTaxRateRaw))/100:0;
  var taxCY,taxDE,taxU;
  if(sdMode){
    taxCY=rents.map(function(r,i){var furnAfa=i<5?Math.round(furnAfaAnn*fA[i]):0;var d=Math.round(dCY*fA[i]);
      var taxable=r-d-furnAfa-mgmt[i]-intC[i];return Math.max(0,Math.round(taxable*sdTaxRate));});
    taxDE=Array(10).fill(0);taxU=taxCY;
  } else {
    taxCY=rents.map(function(r,i){var furnAfa=i<5?Math.round(furnAfaAnn*fA[i]):0;
      var d=Math.round(dCY*fA[i]),m2=Math.round(r*0.2),tx=r-d-furnAfa-m2-intC[i];
      if(resCY){var b=cyTax(cyBI);return Math.max(0,cyTax(cyBI+Math.max(0,tx))-b);}return cyTax(Math.max(0,tx));});
    var bDE=pGross*0.8,rDE=bDE;var dDE=[];
    for(var k2=0;k2<10;k2++){var d2=Math.round(rDE*0.05*fA[k2]);dDE.push(d2);rDE=Math.max(0,rDE-d2);}
    var deR=deTx/100;
    taxDE=resCY?Array(10).fill(0):rents.map(function(r,i){var furnAfa=i<5?Math.round(furnAfaAnn*fA[i]):0;
      var g2=Math.round((r-mgmt[i]-intC[i]-dDE[i]-furnAfa)*deR);return g2<=0?g2:g2-Math.min(taxCY[i],g2);});
    taxU=resCY?taxCY:taxDE;
  }
  const cfA=rents.map(function(r,i){return r-mgmt[i]-rateC[i]+(vatA[i]||0)-taxU[i];});
  const propV=Array.from({length:10},function(_,i){return Math.round(pGross*Math.pow(1+appP/100,(i+1)-(1-fA[0])));});
  var sum=function(a){return a.reduce(function(x,y){return x+y;},0);};
  var sumR=sum(rents),sumC=sum(mgmt)+sum(intC),sumT=sum(taxCY)+sum(taxDE);
  var sumVat=sum(vatA),sumPP=sum(prepayC),sumCF=sum(cfA);
  var ek10=propV[9]-restL[9];var totRet=sumCF+(ek10-ekStart);var roe10=ekStart>0?totRet/ekStart*100:0;
  var furnForIRR=furnFree?0:furnCost;var ekForIRR=ekStart+furnForIRR;
  var cfIRR=[-ekForIRR].concat(cfA);cfIRR[cfIRR.length-1]+=ek10;var irrV=irrCalc(cfIRR);
  var mRate=rateC[0]/Math.max(1,mF);var mCF=cfA[0]/Math.max(1,mF);
  var effYield=pGross>0?baseR/pGross*100:yPct;
  return {km,ky,pNet,pNetList,pGross,pGrossList,vatAmt,costs,loan,ekStart,ekAbs,sumR,sumC,sumT,sumVat,sumPP,sumCF,ek10,totRet,roe10,irrV,mRate,mCF,effYield,
    rents,mgmt,intC,rateC,restL,prepayC,propV,vatA,taxCY,taxDE,cfA};
}

// ── Test-Setup ───────────────────────────────────────────────────────────────
function setSingle(o){
  VALS={'s-month':o.month,'s-year':o.year,'s-price':o.priceNet,'s-discount':o.discountPct,'s-bedrooms':o.bedrooms,
    's-equity':o.equity,'s-cyi':o.cyBI,'s-yield':o.yieldPct,'s-rg':o.rentGrowth,'s-mgmt':o.mgmtPct,'s-int':o.interestPct,
    's-term':o.termYears,'s-amort':o.amortPct,'s-app':o.appreciationPct,'s-det':o.deTaxPct,'s-furn':o.furnCost};
  RADIOS={'s-dealtype':'single','s-fin':o.fin,'s-let':o.letType,'s-mode':o.mode,'s-res':o.res,'furn-free':o.furnFree?'yes':'no'};
  CHECKS={'s-hotel':!!o.hotelConcept};
  ppVals=o.ppVals?o.ppVals.slice():Array(10).fill(0);
}
const base={month:6,year:2027,dealType:'single',priceNet:320000,discountPct:0,bedrooms:2,fin:'yes',letType:'short',mode:'ann',res:'de',hotelConcept:false,equity:75000,cyBI:0,yieldPct:7.5,rentGrowth:5,mgmtPct:2,interestPct:4.1,termYears:20,amortPct:2,appreciationPct:4.5,deTaxPct:42,furnCost:0,furnFree:false,ppVals:Array(10).fill(0),sdInputMode:'manual',sdUnits:[],sdPrice:1000000,sdSqm:250,sdTerr:60,sdNum:3,sdDiscount:0,sdVatDrawn:0,sdVatYears:0,sdTaxRate:12.5};

const cases = [
  ['PDF Emerald (single,short,ann,de)', base],
  ['Langzeit + Tilgung + CY-Sitz', {...base, letType:'long', mode:'tilg', res:'cy', cyBI:30000, priceNet:445000, appreciationPct:6.5, yieldPct:7.2}],
  ['Ohne Finanzierung (Cash)', {...base, fin:'no', priceNet:688800, appreciationPct:7, yieldPct:8}],
  ['Mit Einrichtung + Sondertilgung', {...base, furnCost:35000, furnFree:false, ppVals:[0,0,20000,0,0,10000,0,0,0,0]}],
  ['Discount + Hotel', {...base, discountPct:7.5, hotelConcept:true, equity:50000}],
]

const numKeys=['km','ky','pNet','pNetList','pGross','pGrossList','vatAmt','costs','loan','ekStart','ekAbs','sumR','sumC','sumT','sumVat','sumPP','sumCF','ek10','totRet','roe10','irrV','mRate','mCF','effYield']
const arrKeys=['rents','mgmt','intC','rateC','restL','prepayC','propV','vatA','taxCY','taxDE','cfA']
let allOk=true
for(const [name,o] of cases){
  setSingle(o)
  const a=computeOrig()
  const b=port(o)
  let maxDiff=0, worst=''
  for(const k of numKeys){ const d=Math.abs((a[k]??0)-(b[k]??0)); if(d>maxDiff){maxDiff=d;worst=k} }
  for(const k of arrKeys){ for(let i=0;i<10;i++){ const d=Math.abs((a[k][i]??0)-(b[k][i]??0)); if(d>maxDiff){maxDiff=d;worst=k+'['+i+']'} } }
  const ok = maxDiff < 1e-6
  allOk = allOk && ok
  console.log(`${ok?'✅':'❌'} ${name}  | maxDiff=${maxDiff.toExponential(2)} (${worst})  | IRR=${(b.irrV*100).toFixed(2)}% EK10=${Math.round(b.ek10).toLocaleString('de-DE')} CF1=${Math.round(b.cfA[0])}`)
}
console.log(allOk ? '\n🎉 ALLE Fälle: Portierung == Original (bit-genau).' : '\n⚠️ ABWEICHUNG gefunden!')
process.exit(allOk?0:1)