/* Página de pedido confirmado (antes ficava dentro do HTML; a CSP não aceita mais). */
const money=v=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(v||0));
const params=new URLSearchParams(location.search);
const orderNsu=params.get("order_nsu");
const confirmationToken=params.get("confirmation_token");
const reduceMotion=window.matchMedia("(prefers-reduced-motion: reduce)");
let lastOrder=null;
let wasPaid=null;
let pollTimer=null;
let pollCount=0;

function esc(v){
  return String(v??"").replace(/[&<>"']/g,m=>({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}

async function fetchOrder(){
  if(!orderNsu||!confirmationToken) throw new Error("Não foi possível validar a confirmação deste pedido.");
  const r=await fetch("/api/pedido-confirmacao?order_nsu="+encodeURIComponent(orderNsu)+"&confirmation_token="+encodeURIComponent(confirmationToken),{cache:"no-store"});
  const d=await r.json();
  if(!r.ok||!d.success) throw new Error(d.message||"Pedido não encontrado.");
  return d.order;
}

function isPaid(o){
  return ["paid","processing","shipped","delivered"].includes(o.status);
}

function firstName(name){
  const first=String(name||"").trim().split(/\s+/)[0]||"";
  return first ? first.charAt(0).toUpperCase()+first.slice(1).toLowerCase() : "";
}

function formatDate(value){
  const date=value?new Date(value):new Date();
  return isNaN(date)?"—":date.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric"});
}

function renderOrder(o){
  lastOrder=o;
  const paid=isPaid(o);
  const name=firstName(o.customer_name);
  const letter=document.getElementById("letter");

  setHTML(document.getElementById("kicker"), paid
    ? "COMPRA CONFIRMADA"
    : '<span class="dot" aria-hidden="true"></span>PAGAMENTO EM CONFIRMAÇÃO');
  document.getElementById("title").textContent=paid
    ? (name ? "Obrigada, "+name+"." : "Obrigada pela sua compra.")
    : (name ? "Recebemos seu pedido, "+name+"." : "Recebemos seu pedido.");
  document.getElementById("subtitle").textContent=paid
    ? "Sua compra foi confirmada. Cada peça MONTÊ é separada à mão e embalada com cuidado para chegar até você."
    : "Assim que a InfinitePay confirmar o pagamento, esta carta se atualiza sozinha e você recebe um e-mail.";

  const payment=o.payment_method==="pix"?"Pix":o.payment_method==="credit_card"?"Cartão":"—";
  setHTML(document.getElementById("orderMeta"), '<div><span>NÚMERO</span><strong>'+esc(o.order_code||"—")+'</strong></div>'+
    '<div><span>DATA</span><strong>'+esc(formatDate(o.created_at))+'</strong></div>'+
    '<div><span>PAGAMENTO</span><strong>'+esc(payment)+(paid?" · pago":" · pendente")+'</strong></div>');

  const items=o.items||[];
  setHTML(document.getElementById("items"), items.length ? items.map(i=>
    '<div class="item"><span class="item-name">'+esc(i.product_name)+'</span>'+
    '<span class="item-price">'+money(i.total_price)+'</span>'+
    '<span class="item-meta">'+(i.variant_color?esc(i.variant_color)+" · ":"")+Number(i.quantity||0)+(Number(i.quantity)===1?" peça":" peças")+'</span></div>'
  ).join("") : '<p class="letter-text ps-s9">Itens do pedido indisponíveis no momento.</p>');

  const subtotal=Number(o.subtotal||0), shipping=Number(o.shipping||0), total=Number(o.total||0);
  const discount=Math.round((subtotal+shipping-total)*100)/100;
  setHTML(document.getElementById("totals"), (subtotal?'<div><span>Peças</span><span>'+money(subtotal)+'</span></div>':"")+
    (discount>0?'<div><span>Desconto Pix</span><span>-'+money(discount)+'</span></div>':"")+
    '<div><span>Frete</span><span>'+money(shipping)+'</span></div>'+
    '<div class="grand"><span>TOTAL</span><strong>'+money(total)+'</strong></div>');

  if(wasPaid===false && paid){
    letter.classList.remove("just-paid");
    void letter.offsetWidth;
    letter.classList.add("just-paid");
  }
  wasPaid=paid;

  if(!paid) startPaymentPolling(); else stopPolling();
}

function showError(msg){
  stopPolling();
  document.getElementById("kicker").textContent="PEDIDO";
  document.getElementById("title").textContent="Não encontramos seu pedido.";
  document.getElementById("subtitle").textContent=msg+" Se você concluiu o pagamento, confira seu e-mail ou fale com a MONTÊ.";
  document.querySelectorAll(".letter-section").forEach(el=>el.hidden=true);
}

async function loadOrder(){
  try{
    renderOrder(await fetchOrder());
  }catch(e){
    showError(e.message||"Não foi possível carregar o pedido agora.");
  }
}

function startPaymentPolling(){
  if(pollTimer||pollCount>=30)return;
  pollTimer=setInterval(async()=>{
    pollCount++;
    try{
      const o=await fetchOrder();
      renderOrder(o);
      if(isPaid(o)||pollCount>=30)stopPolling();
    }catch(e){
      if(pollCount>=15)stopPolling();
    }
  },2000);
}

function stopPolling(){
  if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
}

/* Parallax: a carta inclina com o ponteiro; camadas internas, monograma e
   poeira dourada se movem em profundidades diferentes. */
(function setupParallax(){
  const letter=document.getElementById("letter");
  const monogram=document.querySelector(".bg-monogram");
  const dust=document.querySelector(".dust");
  window.addEventListener("pointermove",e=>{
    if(reduceMotion.matches||e.pointerType==="touch"||letter.classList.contains("is-closing"))return;
    const x=e.clientX/window.innerWidth-.5, y=e.clientY/window.innerHeight-.5;
    letter.style.setProperty("--ry",(x*7).toFixed(2)+"deg");
    letter.style.setProperty("--rx",(y*-5).toFixed(2)+"deg");
    letter.style.setProperty("--px",(x*2).toFixed(2));
    letter.style.setProperty("--py",(y*2).toFixed(2));
    monogram.style.setProperty("--bx",(x*-40).toFixed(1)+"px");
    monogram.style.setProperty("--by",(y*-30).toFixed(1)+"px");
    dust.style.setProperty("--dx",(x*24).toFixed(1)+"px");
    dust.style.setProperty("--dy",(y*18).toFixed(1)+"px");
  },{passive:true});
  let ticking=false;
  window.addEventListener("scroll",()=>{
    if(ticking||reduceMotion.matches)return;
    ticking=true;
    requestAnimationFrame(()=>{
      ticking=false;
      monogram.style.setProperty("--by",(scrollY*-.25).toFixed(1)+"px");
      dust.style.setProperty("--dy",(scrollY*-.12).toFixed(1)+"px");
    });
  },{passive:true});
})();

/* Retornar ao site: a carta dobra em três, recebe o selo de cera e volta à loja. */
function homeUrl(){
  return /onrender\.com$/i.test(location.hostname) ? "https://oficialmontee.com.br/" : "/";
}

function closeLetter(){
  const button=document.getElementById("returnButton");
  if(button.disabled)return;
  button.disabled=true;
  if(reduceMotion.matches){ location.href=homeUrl(); return; }

  const letter=document.getElementById("letter");
  const stage=document.getElementById("foldStage");
  const fold=document.getElementById("fold");
  const seal=document.getElementById("seal");
  const ring=document.getElementById("sealRing");
  const veil=document.getElementById("veil");
  const rect=letter.getBoundingClientRect();

  letter.classList.add("is-closing");
  ["--rx","--ry","--px","--py"].forEach(n=>letter.style.removeProperty(n));

  // A folha dobrada cabe na tela, com a proporção da carta.
  const width=Math.min(rect.width, window.innerWidth*.9);
  const height=Math.min(rect.height, window.innerHeight*.78, width*1.55);
  fold.style.width=width+"px";
  fold.style.height=height+"px";
  const third=height/3;
  fold.querySelectorAll(".fold-panel").forEach((panel,i)=>{
    panel.style.height=(third+.5)+"px";
    panel.style.top=(i*third)+"px";
  });

  const sealWrap=document.getElementById("sealWrap");
  const at=(ms,fn)=>setTimeout(fn,ms);
  at(250,()=>{ stage.hidden=false; });
  at(820,()=>fold.classList.add("is-folded"));
  at(1950,()=>{
    seal.classList.add("is-stamped");
    at(260,()=>{ ring.classList.add("is-on"); fold.classList.add("is-sealed"); });
  });
  at(3000,()=>{ fold.classList.add("is-leaving"); sealWrap.classList.add("is-leaving"); veil.classList.add("is-on"); });
  at(3650,()=>{ location.href=homeUrl(); });
}

document.getElementById("returnButton").addEventListener("click",closeLetter);
loadOrder();
