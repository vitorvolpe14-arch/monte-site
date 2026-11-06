const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(path,options={}){const r=await fetch(path,{credentials:"same-origin",headers:{"Content-Type":"application/json",...(options.headers||{})},...options});let d=null;try{d=await r.json()}catch{}if(!r.ok){const e=new Error(d?.message||"Não foi possível concluir a operação.");e.status=r.status;throw e}return d}
let products=[],orders=[],editingProduct=null,productImageDraft=[],productImageFiles=[];

let analyticsData=null;
let coupons=[],couponsLoaded=false;
let promotions=[],promotionsLoaded=false,storeBenefitsData=null;
async function loadAnalytics(){try{$("analyticsError").textContent="";analyticsData=await api("/api/admin/analytics?days="+Number($("analyticsDays").value||30));renderAnalytics()}catch(e){$("analyticsError").textContent=e.message}}
function renderAnalytics(){
 const d=analyticsData.summary||{}, k=[["Visitantes únicos",fmtInt(d.visitors)],["Visualizações",fmtInt(d.pageViews)],["Pedidos pagos",fmtInt(d.paidOrders)],["Faturamento bruto",money(d.grossRevenue)],["Ticket médio",money(d.ticketAverage)],["Conversão",pct(d.conversionRate)],["Carrinhos ativos",fmtInt(d.activeCarts)],["Valor em abandono",money(d.abandonedValue)]];
 setHTML($("analyticsKpis"), k.map(x=>'<div class="analytics-kpi"><span>'+x[0]+'</span><strong>'+x[1]+'</strong></div>').join(""));
 renderVisitsRevenueChart(analyticsData.series||[]);

 const f=[["Visitas",d.visitors],["Add ao carrinho",d.addToCart],["Checkout",d.checkoutStarted],["Pagos",d.paidOrders]]; setHTML($("analyticsFunnel"), f.map((x,i)=>'<div class="funnel-row"><span>'+x[0]+'</span><strong>'+fmtInt(x[1])+'</strong>'+(i?'<em>'+pct(Number(f[i-1][1])?x[1]/f[i-1][1]*100:0)+'</em>':'')+'</div>').join(""));
 setHTML($("analyticsCarts"), '<div class="mini-stats"><div><span>Abandono estimado</span><strong>'+pct(d.abandonmentRate)+'</strong></div><div><span>Carrinhos convertidos</span><strong>'+fmtInt(d.convertedCarts)+'</strong></div></div><p class="analytics-note">'+fmtInt(d.activeCarts)+' carrinhos ativos representam '+money(d.abandonedValue)+'.</p>');
 const pays=Object.entries(analyticsData.paymentMethods||{});setHTML($("analyticsPayments"), pays.length?'<table class="table"><thead><tr><th>MEIO</th><th>RECEITA</th></tr></thead><tbody>'+pays.map(x=>'<tr><td>'+esc(x[0])+'</td><td>'+money(x[1])+'</td></tr>').join("")+'</tbody></table>':'<p>Nenhum pagamento.</p>');
 const tops=analyticsData.topProducts||[];setHTML($("analyticsTopProducts"), tops.length?'<table class="table"><thead><tr><th>PRODUTO</th><th>UNID.</th><th>RECEITA</th></tr></thead><tbody>'+tops.map(x=>'<tr><td>'+esc(x.key)+'</td><td>'+fmtInt(x.units)+'</td><td>'+money(x.revenue)+'</td></tr>').join("")+'</tbody></table>':'<p>Nenhuma venda.</p>');
 setHTML($("analyticsOrders"), orderTable(analyticsData.recentOrders||[]));
 const cs=analyticsData.recentCarts||[];setHTML($("analyticsRecentCarts"), cs.length?'<table class="table"><thead><tr><th>ATIVIDADE</th><th>CLIENTE</th><th>ITENS</th><th>TOTAL</th><th>STATUS</th></tr></thead><tbody>'+cs.map(x=>'<tr><td>'+date(x.last_activity_at)+'</td><td>'+esc(x.customer_name||x.customer_email||"Visitante")+'</td><td>'+fmtInt(Array.isArray(x.items)?x.items.reduce((n,i)=>n+Number(i.quantity||1),0):0)+'</td><td>'+money(x.total)+'</td><td>'+esc(x.status)+'</td></tr>').join("")+'</tbody></table>':'<p>Nenhum carrinho.</p>');
}
function fmtInt(v){return new Intl.NumberFormat("pt-BR").format(Number(v||0))}
function pct(v){return Number(v||0).toLocaleString("pt-BR",{maximumFractionDigits:1})+"%"}
function renderVisitsRevenueChart(series){
 const raw=Array.isArray(series)?series:[];
 const data=(window.matchMedia&&window.matchMedia("(max-width:620px)").matches?raw.slice(-7):raw.slice(-14));
 if(!data.length){setHTML($("analyticsChart"), '<div class="analytics-empty-chart">Sem dados para o período selecionado.</div>');return}
 const W=900,H=330,left=58,right=58,top=30,bottom=52,plotW=W-left-right,plotH=H-top-bottom;
 const maxV=Math.max(1,...data.map(x=>Number(x.visitors||0))),maxR=Math.max(1,...data.map(x=>Number(x.revenue||0)));
 const points=data.map((x,i)=>({x:left+(data.length===1?plotW/2:i*(plotW/(data.length-1))),v:Number(x.visitors||0),r:Number(x.revenue||0),date:String(x.date||"").slice(5)}));
 const yV=v=>top+plotH-(v/maxV)*plotH, yR=v=>top+plotH-(v/maxR)*plotH;
 const line=points.map((p,i)=>(i?"L":"M")+p.x.toFixed(1)+" "+yR(p.r).toFixed(1)).join(" ");
 const area=line+" L "+points[points.length-1].x.toFixed(1)+" "+(top+plotH)+" L "+points[0].x.toFixed(1)+" "+(top+plotH)+" Z";
 const grid=[0,.25,.5,.75,1].map(t=>{const y=top+plotH-(t*plotH);const v=Math.round(maxV*t);const r=maxR*t;return '<line x1="'+left+'" y1="'+y+'" x2="'+(W-right)+'" y2="'+y+'" class="chart-grid-line"/><text x="'+(left-10)+'" y="'+(y+4)+'" text-anchor="end" class="chart-axis chart-axis-left">'+fmtInt(v)+'</text><text x="'+(W-right+10)+'" y="'+(y+4)+'" class="chart-axis chart-axis-right">'+money(r)+'</text>'}).join("");
 const bars=points.map(p=>{const bh=Math.max(2,(p.v/maxV)*plotH),bw=Math.min(28,Math.max(10,plotW/data.length*.42));return '<rect x="'+(p.x-bw/2).toFixed(1)+'" y="'+(top+plotH-bh).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+bh.toFixed(1)+'" rx="2" class="chart-visits-bar"><title>'+esc(p.date)+' · '+fmtInt(p.v)+' visitas</title></rect>'}).join("");
 const dots=points.map(p=>'<circle cx="'+p.x.toFixed(1)+'" cy="'+yR(p.r).toFixed(1)+'" r="4" class="chart-revenue-dot"><title>'+esc(p.date)+' · '+money(p.r)+' faturamento</title></circle>').join("");
 const labels=points.map(p=>'<text x="'+p.x.toFixed(1)+'" y="'+(H-20)+'" text-anchor="middle" class="chart-date-label">'+esc(p.date)+'</text>').join("");
 const totalV=data.reduce((n,x)=>n+Number(x.visitors||0),0),totalR=data.reduce((n,x)=>n+Number(x.revenue||0),0);
 setHTML($("analyticsChart"), '<div class="analytics-chart-head"><div><strong>Visitas × faturamento</strong><span>Comparação diária no período selecionado</span></div><div class="analytics-chart-totals"><span><i class="legend-dot visits"></i>'+fmtInt(totalV)+' visitas</span><span><i class="legend-dot revenue"></i>'+money(totalR)+' faturamento</span></div></div><div class="professional-chart"><svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Gráfico comparando visitas ao site e faturamento bruto"><g>'+grid+'</g><g>'+bars+'</g><path d="'+area+'" class="chart-revenue-area"/><path d="'+line+'" class="chart-revenue-line"/><g>'+dots+'</g><g>'+labels+'</g></svg></div><div class="chart-legend"><span><i class="legend-swatch visits"></i><strong>Visitas ao site</strong><small>Número de acessos/visitantes registrados</small></span><span><i class="legend-swatch revenue"></i><strong>Faturamento bruto</strong><small>Valor bruto dos pedidos pagos</small></span></div>');
}

document.addEventListener("DOMContentLoaded",init);
async function init(){
  const loginForm=$("loginForm"); if(loginForm) loginForm.addEventListener("submit",login);
  const logoutButton=$("logoutButton"); if(logoutButton) logoutButton.addEventListener("click",logout);
  document.querySelectorAll(".nav-button").forEach(b=>b.onclick=()=>showSection(b.dataset.section));
  document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>showSection(b.dataset.go));
  const newProductButton=$("newProductButton"); if(newProductButton) newProductButton.onclick=()=>openProduct();
  const closeModalButton=$("closeModal"); if(closeModalButton) closeModalButton.onclick=closeProduct;
  const closeOrderModalButton=$("closeOrderModal"); if(closeOrderModalButton) closeOrderModalButton.onclick=closeOrder;
  const cancelProductButton=$("cancelProduct"); if(cancelProductButton) cancelProductButton.onclick=closeProduct;
  const deleteProductButton=$("deleteProductButton"); if(deleteProductButton) deleteProductButton.onclick=deleteEditingProduct;
  const addVariantButton=$("addVariant"); if(addVariantButton) addVariantButton.onclick=()=>addVariant();
  const productForm=$("productForm"); if(productForm) productForm.onsubmit=saveProduct;
  const productSearch=$("productSearch"); if(productSearch) productSearch.oninput=renderProducts;
  const olistOnlyFilter=$("olistOnlyFilter"); if(olistOnlyFilter) olistOnlyFilter.onchange=renderProducts;
  const deleteOlistProductsButton=$("deleteOlistProductsButton"); if(deleteOlistProductsButton) deleteOlistProductsButton.onclick=deleteOlistProducts;
  bindProductImageDropzone();
  const refreshOrders=$("refreshOrders"); if(refreshOrders) refreshOrders.onclick=loadOrders;
  const refreshStock=$("refreshStock"); if(refreshStock) refreshStock.onclick=loadStockMovements;
  const compareSkuButton=$("compareSkuButton"); if(compareSkuButton) compareSkuButton.onclick=compareSkus;
  const stockSyncButton=$("stockSyncButton"); if(stockSyncButton) stockSyncButton.onclick=runStockSync;
  ["olistSyncPrices","olistSyncColors"].forEach(id=>{const el=$(id); if(el) el.onchange=saveOlistSyncSettings;});
  const refreshAnalytics=$("refreshAnalytics"); if(refreshAnalytics) refreshAnalytics.onclick=loadAnalytics;
  const analyticsDays=$("analyticsDays"); if(analyticsDays) analyticsDays.onchange=loadAnalytics;
  const couponForm=$("couponForm"); if(couponForm) couponForm.onsubmit=saveCoupon;
  const couponType=$("couponType"); if(couponType) couponType.onchange=updateCouponValueLabel;
  const cancelCouponEdit=$("cancelCouponEdit"); if(cancelCouponEdit) cancelCouponEdit.onclick=resetCouponForm;
  const refreshCoupons=$("refreshCoupons"); if(refreshCoupons) refreshCoupons.onclick=loadCoupons;
  const promoForm=$("promoForm"); if(promoForm) promoForm.onsubmit=savePromotion;
  const promoEvery=$("promoEvery"); if(promoEvery){promoEvery.onchange=syncPromoEvery;syncPromoEvery()}
  const benefitsForm=$("benefitsForm"); if(benefitsForm) benefitsForm.onsubmit=saveBenefits;
  const topBarForm=$("topBarForm"); if(topBarForm) topBarForm.onsubmit=saveTopBar;
  const addTopBarButton=$("addTopBarButton"); if(addTopBarButton) addTopBarButton.onclick=addTopBarMessage;
  if($("topBarList")) renderTopBarList([]);
  const clearTopBarButton=$("clearTopBarButton"); if(clearTopBarButton) clearTopBarButton.onclick=clearTopBar;
  const cancelPromoEdit=$("cancelPromoEdit"); if(cancelPromoEdit) cancelPromoEdit.onclick=resetPromotionForm;
  const refreshPromotions=$("refreshPromotions"); if(refreshPromotions) refreshPromotions.onclick=loadPromotions;
  try{const s=await api("/api/admin/session");await enterApp(s)}catch{showLogin()}
}
function showLogin(){$("loginView").classList.remove("hidden");$("appView").classList.add("hidden");$("loginEmail").focus()}
async function login(e){e.preventDefault();$("loginError").textContent="";try{await enterApp(await api("/api/admin/login",{method:"POST",body:JSON.stringify({email:$("loginEmail").value.trim(),password:$("loginPassword").value})}))}catch(e){$("loginError").textContent=e.message}}
async function logout(){try{await api("/api/admin/logout",{method:"POST"})}catch{}products=[];orders=[];showLogin();$("loginPassword").value=""}
async function enterApp(s){$("loginView").classList.add("hidden");$("appView").classList.remove("hidden");$("adminEmail").textContent=s.email||"Administrador";if(typeof window.ensureCarouselSharePreview==="function")window.ensureCarouselSharePreview();loadOlistSales().then(()=>{if(olistSalesEnabled)syncOlistSalesNow()});loadInfinitePayReport();try{await Promise.all([loadProducts(),loadOrders(),loadStockMovements()]);renderDashboard()}catch(e){console.error("Falha ao carregar dados do painel:",e);$("loginError").textContent="Login realizado, mas houve um erro ao carregar os dados. Atualize a página e tente novamente.";renderDashboard()}}
function showSection(s){document.querySelectorAll(".section").forEach(x=>x.classList.add("hidden"));$(s+"Section").classList.remove("hidden");document.querySelectorAll(".nav-button").forEach(b=>{const on=b.dataset.section===s;b.classList.toggle("active",on);if(on&&window.matchMedia&&window.matchMedia("(max-width:800px)").matches)b.scrollIntoView({block:"nearest",inline:"center"})});window.scrollTo(0,0);$("pageTitle").textContent={dashboard:"Visão geral",products:"Produtos",carousel:"Banners",orders:"Pedidos",coupons:"Cupons",promotions:"Promoções",stock:"Estoque",analytics:"Analytics & Financeiro"}[s];if(s==="analytics")loadAnalytics();if(s==="products")renderProducts();if(s==="carousel"&&typeof window.loadCarousel==="function")window.loadCarousel();if(s==="orders")renderOrders();if(s==="coupons")loadCoupons();if(s==="promotions")loadPromotions();if(s==="stock"){renderStock();loadStockSyncStatus()}}
async function loadProducts(){const d=await api("/api/admin/products");products=d.products||[];renderProducts();renderStock();renderDashboard();renderPhotoOptimizerInfo()}
async function loadStockMovements(){try{const d=await api("/api/admin/stock/movements");renderStockMovements(d.movements||[])}catch(e){setHTML($("stockMovements"), '<p>'+esc(e.message)+'</p>')}}
async function loadOrders(){const d=await api("/api/admin/orders");orders=d.orders||[];infinitePayFees=d.infinitepay_fees||null;renderOrders();renderDashboard()}
// renderDashboard: bloco "VISÃO GERAL — DASHBOARD", no fim do arquivo.
function isOlistProduct(p){return p.olist_product_id!==null&&p.olist_product_id!==undefined&&p.olist_product_id!==""}
function renderOlistCleanup(){const bar=$("olistCleanupBar");if(!bar)return;const list=products.filter(isOlistProduct);bar.classList.toggle("hidden",!list.length);if(!list.length){if($("olistOnlyFilter"))$("olistOnlyFilter").checked=false;return}const withPhotos=list.filter(p=>Array.isArray(p.images)&&p.images.some(img=>String(img||"").trim())).length;$("olistCleanupTitle").textContent=list.length+" produto(s) sincronizado(s) da Olist";$("olistCleanupInfo").textContent=withPhotos+" com foto · "+(list.length-withPhotos)+" sem foto. Marque “Mostrar só Olist” para revisar antes de excluir."}
async function deleteOlistProducts(){const list=products.filter(isOlistProduct);if(!list.length)return;const withPhotos=list.filter(p=>Array.isArray(p.images)&&p.images.some(img=>String(img||"").trim())).length;const names=list.slice(0,15).map(p=>"• "+(p.name||"Sem nome")+(p.sku?" ("+p.sku+")":"")).join("\n")+(list.length>15?"\n… e mais "+(list.length-15)+" produto(s)":"");if(!window.confirm("Excluir "+list.length+" produto(s) sincronizado(s) da Olist?\n\n"+names+"\n\nCom foto: "+withPhotos+". Produtos que já têm pedidos serão apenas desativados.\n\nEsta ação não pode ser desfeita."))return;const button=$("deleteOlistProductsButton");if(button){button.disabled=true;button.textContent="EXCLUINDO..."}try{const d=await api("/api/admin/olist/products/delete",{method:"POST",body:JSON.stringify({product_ids:list.map(p=>p.id)})});await loadProducts();const lines=[d.deleted+" produto(s) excluído(s)."];if(d.deactivated_with_orders)lines.push(d.deactivated_with_orders+" produto(s) com pedidos foram desativados (não aparecem mais na loja).");if(d.failed?.length)lines.push(d.failed.length+" produto(s) não puderam ser excluídos e foram desativados.");window.alert(lines.join("\n"))}catch(e){window.alert(e.message)}finally{if(button){button.disabled=false;button.textContent="EXCLUIR PRODUTOS DA OLIST"}}}
function renderProducts(){renderOlistCleanup();const q=($("productSearch").value||"").toLowerCase();const olistOnly=!!$("olistOnlyFilter")?.checked;const list=products.filter(p=>(!olistOnly||isOlistProduct(p))&&(p.name+" "+(p.sku||"")).toLowerCase().includes(q));if($("productsCount"))$("productsCount").textContent=list.length===products.length?products.length+(products.length===1?" produto":" produtos"):list.length+" de "+products.length+" produtos";setHTML($("productsGrid"), list.map(p=>{const img=Array.isArray(p.images)&&p.images[0]?smallPhoto(p.images[0]):"";const stock=(p.product_variants||[]).reduce((n,v)=>n+Number(v.stock||0),0);const tags=(p.active?"":'<span class="chip chip-off">INATIVO</span>')+(p.is_new?'<span class="chip">NOVO</span>':"")+(p.is_sale?'<span class="chip chip-sale">SALE</span>':"")+(p.is_presale?'<span class="chip chip-presale">PRÉ-VENDA</span>':"")+(stock<=2?'<span class="chip chip-low">ESTOQUE BAIXO</span>':"");return `<article class="admin-product${p.active?"":" is-inactive"}"><div class="admin-product-tags">${tags}</div><img src="${esc(img)}" alt="" data-img-error="hide"><div class="admin-product-body"><h3>${esc(p.name)}</h3><div class="admin-product-price">${p.sale_price?`<s>${money(p.price)}</s>`:""}<span>${money(p.sale_price||p.price)}</span></div><div class="meta">${esc(p.sku||"SEM SKU")} · estoque ${stock}${isOlistProduct(p)?'<span class="badge olist-badge">OLIST</span>':""}</div>${productLinkHtml(p)}<div class="admin-product-actions"><button class="edit-product-button" title="Editar produto" aria-label="Editar produto" data-click="openProduct" data-args="${esc(JSON.stringify([p.id]))}">EDITAR</button><button class="secondary" data-click="toggleProduct" data-args="${esc(JSON.stringify([p.id,!p.active]))}">${p.active?"DESATIVAR":"ATIVAR"}</button></div></div></article>`}).join("")||"<p>Nenhum produto encontrado.</p>")}
function renderStock(){const rows=[];products.forEach(p=>(p.product_variants||[]).forEach(v=>rows.push([p,v])));setHTML($("stockTable"), `<table class="table"><thead><tr><th>PRODUTO</th><th>COR</th><th>SKU</th><th>ESTOQUE</th><th>STATUS</th><th></th></tr></thead><tbody>${rows.map(([p,v])=>`<tr><td>${esc(p.name)}</td><td>${esc(v.color)}</td><td>${esc(v.sku||p.sku||"")}</td><td><span class="stock-pill${Number(v.stock)<=0?" is-out":v.stock<=2?" is-low":""}">${v.stock}</span></td><td><span class="badge ${v.active?"paid":"pending"}">${v.active?"ATIVO":"INATIVO"}</span></td><td><button class="secondary small-button" data-click="adjustStock" data-args="${esc(JSON.stringify([v.id,p.name+" — "+v.color,Number(v.stock||0)]))}">AJUSTAR</button></td></tr>`).join("")||"<tr><td colspan='6'>Nenhuma variação cadastrada.</td></tr>"}</tbody></table>`)}
function renderStockMovements(list){if(!list.length){setHTML($("stockMovements"), "<p>Nenhuma movimentação registrada.</p>");return}setHTML($("stockMovements"), `<table class="table"><thead><tr><th>DATA</th><th>PRODUTO</th><th>COR</th><th>TIPO</th><th>QTD.</th><th>MOTIVO</th><th>POR</th></tr></thead><tbody>${list.map(m=>{const v=m.product_variants||{},p=v.products||{};return `<tr><td>${date(m.created_at)}</td><td>${esc(p.name||"—")}</td><td>${esc(v.color||"—")}</td><td>${esc(m.movement_type||"—")}</td><td class="${Number(m.quantity_delta)<0?"stock-negative":"stock-positive"}">${Number(m.quantity_delta)>0?"+":""}${m.quantity_delta}</td><td>${esc(m.reason||"—")}</td><td>${esc(m.created_by||"—")}</td></tr>`}).join("")}</tbody></table>`)}

async function adjustStock(variantId,label,current){const raw=window.prompt(`Ajuste de estoque para ${label}.\nEstoque atual: ${current}\nInforme a quantidade a alterar (ex.: +5 ou -2):`);if(raw===null)return;const delta=Number(String(raw).replace(",","."));if(!Number.isInteger(delta)||delta===0){window.alert("Informe um número inteiro diferente de zero.");return}const reason=window.prompt("Motivo do ajuste:","Reposição de estoque");if(reason===null)return;try{await api("/api/admin/stock/adjust",{method:"POST",body:JSON.stringify({variant_id:variantId,delta,movement_type:delta>0?"restock":"adjustment",reason})});await Promise.all([loadProducts(),loadStockMovements()]);}catch(e){window.alert(e.message)}}

// Forma de envio escolhida pela cliente (PAC, SEDEX, Entrega MONTÊ...).
const SHIPPING_SERVICE_NAMES={"1":"PAC","2":"SEDEX","17":"Mini Envios","monte-fortaleza":"Entrega MONTÊ — Fortaleza","monte-regiao-metropolitana":"Entrega MONTÊ — Região Metropolitana"};
function shippingMethod(o){return String(o.shipping_service_name||"").trim()||SHIPPING_SERVICE_NAMES[String(o.shipping_service_id||"")]||"Não informado"}
function shippingDays(o){const d=Number(o.shipping_delivery_days);return d>0?`${d} ${d===1?"dia útil":"dias úteis"}`:""}
function orderTable(list){if(!list.length)return "<p>Nenhum pedido encontrado.</p>";return `<table class="table order-table"><thead><tr><th>PEDIDO</th><th>CLIENTE</th><th>DATA</th><th>TOTAL</th><th>STATUS</th><th></th></tr></thead><tbody>${list.map(o=>`<tr><td><button class="link-button" data-click="openOrder" data-args="${esc(JSON.stringify([o.id]))}">${esc(o.order_code ? "MONTÊ-"+o.order_code : (o.order_nsu||"—"))}</button><span class="order-shipping-method">${esc(shippingMethod(o))}</span></td><td>${esc(o.customer_name||"—")}</td><td>${date(o.created_at)}</td><td>${money(o.total)}${o.infinitepay&&o.status!=="cancelled"?`<small class="order-net">líquido ${money(o.infinitepay.net)}</small>`:""}</td><td><span class="badge ${esc(o.status||"pending")}">${statusLabel(o.status)}</span>${o.approval_status==="pending"&&o.status==="paid"?' <span class="chip chip-presale">ACEITE OU RECUSE</span>':""}${o.status==="cancelled"&&o.refund_status==="pending"?' <span class="chip chip-low">ESTORNO PENDENTE</span>':""}${isTestOrder(o)?' <span class="chip chip-test">TESTE</span>':""}</td><td><button class="secondary small-button" data-click="openOrder" data-args="${esc(JSON.stringify([o.id]))}">DETALHES</button></td></tr>`).join("")}</tbody></table>`}
// Pedidos sem pagamento há mais de 2 dias ficam "expirados" e escondidos por padrão.
let showExpiredOrders=false,showTestOrders=false;
// Pedidos de teste (is_test) ficam escondidos; a opção de mostrar aparece quando existe algum.
function renderOrders(){const tests=orders.filter(isTestOrder).length,base=showTestOrders?orders:orders.filter(o=>!isTestOrder(o)),expired=base.filter(o=>o.status==="expired").length,toggle=$("ordersExpiredToggle"),testToggle=$("ordersTestToggle");if(toggle){toggle.hidden=!expired;setHTML(toggle, `<input id="showExpiredOrders" type="checkbox" ${showExpiredOrders?"checked":""}> Mostrar ${expired} pedido${expired===1?"":"s"} expirado${expired===1?"":"s"} (sem pagamento há mais de 2 dias)`);$("showExpiredOrders").onchange=e=>{showExpiredOrders=e.target.checked;renderOrders()}}if(testToggle){testToggle.hidden=!tests;setHTML(testToggle, `<input id="showTestOrders" type="checkbox" ${showTestOrders?"checked":""}> Mostrar ${tests} pedido${tests===1?"":"s"} de teste (não ${tests===1?"entra":"entram"} nas contas do painel)`);$("showTestOrders").onchange=e=>{showTestOrders=e.target.checked;renderOrders()}}const real=orders.filter(o=>!isTestOrder(o)),waiting=real.filter(o=>o.approval_status==="pending"&&o.status==="paid").length,refunds=real.filter(o=>o.status==="cancelled"&&o.refund_status==="pending").length;const alerts=(waiting?`<p class="order-alert">${waiting} pedido${waiting>1?"s":""} de pré-venda aguardando você aceitar ou recusar.</p>`:"")+(refunds?`<p class="order-alert">${refunds} estorno${refunds>1?"s":""} pendente${refunds>1?"s":""}: faça no app da InfinitePay e marque como feito no pedido.</p>`:"");setHTML($("ordersTable"), alerts+orderTable(showExpiredOrders?base:base.filter(o=>o.status!=="expired")))}
function statusLabel(s){return({pending:"Aguardando pagamento",expired:"EXPIRADO",paid:"PAGO",processing:"SEPARANDO",shipped:"ENVIADO",delivered:"ENTREGUE",cancelled:"CANCELADO"})[s]||s||"—"}
// Pré-venda: a loja aceita ou recusa; recusado, o estorno é feito no app da InfinitePay.
function decisionCard(o){
  if(o.approval_status==="pending"&&o.status==="paid")return `<div class="detail-card decision-card"><h3>Pré-venda: aceitar ou recusar?</h3><p>Este pedido tem bolsa em pré-venda e foi vendido sem estoque. Ele só segue (Olist, separação e envio) depois que você aceitar.</p><div class="decision-actions"><button type="button" data-click="approveOrder" data-args="${esc(JSON.stringify([o.id]))}">ACEITAR PEDIDO</button><button type="button" class="secondary danger-button" data-click="rejectOrder" data-args="${esc(JSON.stringify([o.id]))}">RECUSAR E ESTORNAR</button></div></div>`;
  if(o.approval_status==="pending")return `<div class="detail-card decision-card"><h3>Pré-venda</h3><p>Aguardando pagamento. Depois de pago, você aceita ou recusa o pedido aqui.</p></div>`;
  if(o.status!=="cancelled")return o.approval_status==="accepted"?`<div class="detail-card"><h3>Pré-venda aceita</h3><p>Aceito em ${date(o.approval_decided_at)}.</p></div>`:"";
  const p=(o.payments||[])[0]||{},nsu=o.transaction_nsu||p.transaction_nsu||"—",receipt=o.receipt_url||p.receipt_url;
  const refund=o.refund_status==="pending"?`<p><strong>Estorno pendente de ${money(o.total)}</strong> (${o.payment_method==="pix"?"Pix":"cartão"}). A InfinitePay não faz estorno pela integração: abra o app da InfinitePay, encontre a venda pela transação <code>${esc(nsu)}</code>${receipt?` (<a href="${esc(receipt)}" target="_blank" rel="noopener">comprovante</a>)`:""} e toque em Estornar. Depois marque aqui; a cliente recebe um e-mail.</p><div class="decision-actions"><button type="button" data-click="markRefundDone" data-args="${esc(JSON.stringify([o.id]))}">MARCAR ESTORNO COMO FEITO</button></div>`:o.refund_status==="done"?`<p>Estorno feito em ${date(o.refund_done_at)}. A cliente foi avisada por e-mail.</p>`:"<p>Nada foi cobrado.</p>";
  return `<div class="detail-card decision-card is-cancelled"><h3>Pedido cancelado</h3><p>Recusado em ${date(o.approval_decided_at)}${o.cancel_reason?` · Motivo: ${esc(o.cancel_reason)}`:""}.</p>${refund}</div>`;
}
async function orderDecision(id,path,body,done){
  try{await api("/api/admin/orders/"+encodeURIComponent(id)+"/"+path,{method:"POST",body:JSON.stringify(body||{})});await loadOrders();openOrder(id);if(done)window.alert(done)}
  catch(e){window.alert(e.message)}
}
function approveOrder(id){if(!window.confirm("Aceitar este pedido de pré-venda? Ele segue para a Olist e a cliente recebe a confirmação por e-mail."))return;orderDecision(id,"approve",{},"Pedido aceito. A cliente foi avisada por e-mail.")}
function rejectOrder(id){const reason=window.prompt("Recusar e cancelar o pedido? A cliente recebe um e-mail avisando que o valor será devolvido.\n\nMotivo (opcional, aparece no e-mail):","");if(reason===null)return;orderDecision(id,"reject",{reason},"Pedido cancelado. Agora faça o estorno no app da InfinitePay e marque como feito no pedido.")}
function markRefundDone(id){if(!window.confirm("Você já fez o estorno no app da InfinitePay? A cliente vai receber um e-mail avisando que o valor foi devolvido."))return;orderDecision(id,"refund-done",{},"Estorno registrado. A cliente foi avisada por e-mail.")}
function reminderLine(o){const s=o.payment_reminder_status;if(!s)return "";const label={sent:"enviado",error:"falhou",skipped_paid_later:"não enviado (comprou em outro pedido)",skipped_newer_order:"não enviado (fez outro pedido)",skipped_sold_out:"não enviado (peças esgotadas)",skipped_invalid_email:"não enviado (e-mail inválido)",skipped_checkout_failed:"não enviado (o pagamento não abriu)"}[s]||s;return `<p>Lembrete por e-mail: <strong>${esc(label)}</strong>${s==="sent"&&o.payment_reminder_sent_at?" em "+date(o.payment_reminder_sent_at):""}</p>`}
function openOrder(id){const o=orders.find(x=>String(x.id)===String(id));if(!o)return;window.currentOrderId=o.id;$("orderModalTitle").textContent=(o.order_code ? "MONTÊ-"+o.order_code : (o.order_nsu||"Pedido"));setHTML($("orderDetails"), orderDetail(o));$("orderModal").classList.remove("hidden")}
function closeOrder(){$("orderModal").classList.add("hidden")}
// Pedido de teste: fora da Visão geral e do Analytics. Dá para marcar e desmarcar aqui.
function testCard(o){return isTestOrder(o)?`<div class="detail-card test-card"><div><h3>Pedido de teste</h3><p>Não entra no faturamento nem nas contas do painel e fica escondido na lista de pedidos.</p></div><button type="button" class="secondary" data-click="setOrderTest" data-args="${esc(JSON.stringify([o.id,false]))}">NÃO É TESTE</button></div>`:`<div class="test-line"><button type="button" class="link-button test-link" data-click="setOrderTest" data-args="${esc(JSON.stringify([o.id,true]))}">Este pedido foi um teste? Marcar como teste</button></div>`}
async function setOrderTest(id,isTest){if(isTest&&!window.confirm("Marcar este pedido como teste?\n\nEle sai do faturamento e das contas do painel e fica escondido na lista de pedidos. Nada é apagado e dá para desfazer."))return;try{await api(`/api/admin/orders/${encodeURIComponent(id)}/test`,{method:"PATCH",body:JSON.stringify({is_test:isTest})});await loadOrders();if(isTest&&!showTestOrders)closeOrder();else openOrder(id);if($("analyticsSection")&&!$("analyticsSection").classList.contains("hidden"))loadAnalytics()}catch(e){window.alert(e.message)}}
function orderDetail(o){const a=o.customer_address||{},p=(o.payments||[])[0]||{},items=o.order_items||[];const presaleIds=new Set((Array.isArray(o.items)?o.items:[]).filter(x=>x&&x.presale===true).map(x=>String(x.variant_id||x.id)));const giftItems=(Array.isArray(o.items)?o.items:[]).filter(x=>x&&x.gift===true);const address=[a.street&&a.number?`${a.street}, ${a.number}`:a.street||"",a.complement||"",a.neighborhood||"",a.cep||"",a.city&&a.state?`${a.city} - ${a.state}`:a.city||a.state||""].filter(Boolean).join(" · ");return `${testCard(o)}${decisionCard(o)}<div class="order-summary-grid"><div class="detail-card"><h3>Cliente</h3><p><strong>${esc(o.customer_name||"—")}</strong></p><p>${esc(o.customer_email||"—")}</p><p>Telefone: ${esc(o.customer_phone||"—")}</p><p>WhatsApp rastreio: <strong>${esc(o.customer_whatsapp||"—")}</strong></p><p>CPF: ${esc(o.customer_cpf||"—")}</p></div><div class="detail-card"><h3>Entrega</h3><p>Forma de envio: <strong class="shipping-method">${esc(shippingMethod(o))}</strong></p>${shippingDays(o)?`<p>Prazo informado à cliente: ${esc(shippingDays(o))}</p>`:""}<p>${esc(address||"—")}</p><p>Frete: ${Number(o.shipping)>0?money(o.shipping):"grátis"}</p></div><div class="detail-card"><h3>Pagamento</h3><p>Status: <strong>${esc(statusLabel(o.status))}</strong></p><p>Transação: ${esc(o.transaction_nsu||p.transaction_nsu||"—")}</p>${String(o.capture_method||p.capture_method||o.payment_method||"").toLowerCase()==="pix"?"<p>Forma de pagamento: <strong>Pix</strong></p>":`<p>Parcelas: ${esc(o.installments||p.installments||"—")}</p>`}${netLines(o)}<p>Pago em: ${date(o.paid_at||p.created_at)}</p>${reminderLine(o)}${o.receipt_url||p.receipt_url?`<a href="${esc(o.receipt_url||p.receipt_url)}" target="_blank" rel="noopener">Abrir comprovante</a>`:""}</div><div class="detail-card"><h3>Resumo</h3><p>Subtotal: ${money(o.subtotal)}</p><p>Frete (${esc(shippingMethod(o))}): ${money(o.shipping)}</p>${o.coupon_code?`<p>Cupom ${esc(o.coupon_code)}: -${money(o.coupon_discount)}</p>`:""}<p class="total-line">Total: ${money(o.total)}</p></div></div><div class="detail-card"><h3>Produtos</h3><div class="order-items">${items.length?items.map(i=>`<div class="order-item"><div><strong>${esc(i.product_name)}${presaleIds.has(String(i.variant_id))||presaleIds.has(String(i.product_id))?' <span class="chip chip-presale">PRÉ-VENDA · ENTREGA EM 10 DIAS ÚTEIS</span>':""}${Number(i.total_price)===0&&giftItems.some(g=>String(g.variant_id)===String(i.variant_id))?' <span class="chip chip-gift">PRESENTE · '+esc(giftItems.find(g=>String(g.variant_id)===String(i.variant_id)).promotion_name||"promoção")+'</span>':""}</strong><span>${esc(i.variant_color||"Sem cor")} · SKU ${esc(i.sku||"—")}</span></div><div>${i.quantity} × ${money(i.unit_price)}<br><strong>${money(i.total_price)}</strong></div></div>`).join(""):"<p>Nenhum item registrado.</p>"}</div></div><div class="detail-card"><h3>Expedição</h3><div class="status-actions"><label>Status<select id="orderStatus">${[...(["pending","expired"].includes(o.status)?[o.status]:[]),"paid","processing","shipped","delivered"].map(s=>`<option value="${s}" ${o.status===s?"selected":""}>${statusLabel(s)}</option>`).join("")}</select></label><label>Transportadora<input id="shippingCarrier" value="${esc(o.shipping_carrier||"")}" placeholder="Ex.: Correios"></label><label>Código de rastreio<input id="trackingCode" value="${esc(o.tracking_code||"")}" placeholder="Código"></label><label>Link de rastreio<input id="trackingUrl" value="${esc(o.tracking_url||"")}" placeholder="https://..."></label></div><p class="whatsapp-admin-status">WhatsApp: <strong>${o.whatsapp_tracking_sent_at?"enviado":"automático"}</strong>${o.whatsapp_tracking_sent_at?" · enviado em "+date(o.whatsapp_tracking_sent_at):""}</p><p class="whatsapp-admin-status">E-mail de atualização: <strong>${esc(o.tracking_email_status||"não enviado")}</strong>${o.tracking_email_sent_at?" · enviado em "+date(o.tracking_email_sent_at):""}</p><div id="orderUpdateError" class="error"></div><div class="modal-actions"><button class="secondary" data-click="closeOrder">FECHAR</button><button class="secondary" data-click="sendTrackingWhatsApp" data-args="${esc(JSON.stringify([o.id]))}">ENVIAR WHATSAPP</button><button class="secondary" data-click="sendTrackingEmail" data-args="${esc(JSON.stringify([o.id]))}">ENVIAR E-MAIL</button>${o.status==="paid" ? '<button class="secondary" data-click="syncPaidOrderOlist" data-args="'+esc(JSON.stringify([o.id]))+'">SINCRONIZAR OLIST</button>' : ''}<button data-click="saveOrderStatus" data-args="${esc(JSON.stringify([o.id]))}">SALVAR STATUS</button></div></div>`}
async function sendTrackingEmail(id){
    const status=$("orderStatus")?.value;
    if(status==="shipped" && !$("trackingCode")?.value.trim()){
        $("orderUpdateError").textContent="Informe o código de rastreio antes de enviar o e-mail de envio.";
        return;
    }
    $("orderUpdateError").textContent="";
    try{
        await api(`/api/admin/orders/${encodeURIComponent(id)}/tracking-email`,{method:"POST"});
        await loadOrders();
        openOrder(id);
        $("orderUpdateError").textContent="E-mail de atualização enviado com sucesso.";
    }catch(e){
        $("orderUpdateError").textContent=e.message;
    }
}

async function saveOrderStatus(id){const status=$("orderStatus").value;const body={status,shipping_carrier:$("shippingCarrier").value.trim(),tracking_code:$("trackingCode").value.trim(),tracking_url:$("trackingUrl").value.trim()};$("orderUpdateError").textContent="";if(status==="shipped"&&!body.tracking_code){$("orderUpdateError").textContent="Informe o código de rastreio para marcar como enviado.";return}try{await api(`/api/admin/orders/${encodeURIComponent(id)}/status`,{method:"PATCH",body:JSON.stringify(body)});await loadOrders();openOrder(id)}catch(e){$("orderUpdateError").textContent=e.message}}

function openProduct(id=null){editingProduct=id?products.find(p=>p.id===id):null;productImageDraft=Array.isArray(editingProduct?.images)?[...editingProduct.images]:[];productImageFiles=[];$("modalTitle").textContent=editingProduct?"Editar produto":"Novo produto";const deleteProductButton=$("deleteProductButton");if(deleteProductButton)deleteProductButton.classList.toggle("hidden",!editingProduct);$("productId").value=editingProduct?.id||"";$("productName").value=editingProduct?.name||"";$("productSku").value=editingProduct?.sku||"";$("productCategory").value=editingProduct?.category||"bolsas";$("productPrice").value=editingProduct?.price??"";$("productSalePrice").value=editingProduct?.sale_price??"";$("productShippingWeight").value=editingProduct?.shipping_weight_kg??"";$("productShippingHeight").value=editingProduct?.shipping_height_cm??"";$("productShippingWidth").value=editingProduct?.shipping_width_cm??"";$("productShippingLength").value=editingProduct?.shipping_length_cm??"";$("productImageFiles").value="";$("productDescription").value=editingProduct?.description||"";$("productNew").checked=!!editingProduct?.is_new;$("productSale").checked=!!editingProduct?.is_sale;$("productPresale").checked=!!editingProduct?.is_presale;$("productActive").checked=editingProduct?!!editingProduct.active:true;$("formError").textContent="";$("variantsList").replaceChildren();(editingProduct?.product_variants||[]).forEach(v=>addVariant(v));renderProductImageManager();$("productModal").classList.remove("hidden")}
function closeProduct(){$("productModal").classList.add("hidden");editingProduct=null}
function addVariant(v={}){const row=document.createElement("div");row.className="variant-row";row.dataset.id=v.id||"";setHTML(row, `<input class="v-color" placeholder="Cor" aria-label="Cor" value="${esc(v.color||"")}"><input class="v-sku" placeholder="SKU da cor" aria-label="SKU da cor" value="${esc(v.sku||"")}"><input class="v-stock" type="number" min="0" aria-label="Estoque" value="${Number(v.stock||0)}"><button type="button" class="remove-variant" aria-label="Remover cor" title="Remover cor">×</button>`);row.querySelector(".remove-variant").onclick=()=>row.remove();$("variantsList").appendChild(row)}
function readFileAsDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error("Não foi possível ler a imagem."));r.readAsDataURL(file)})}
function validateProductImage(file){if(file.size>20*1024*1024)throw new Error("A imagem "+file.name+" ultrapassa 20 MB.");if(!["image/jpeg","image/png","image/webp"].includes(file.type))throw new Error("A imagem "+file.name+" precisa ser JPG, PNG ou WebP.")}
function setProductImageStatus(message="",error=false){const el=$("productImageUploadStatus");if(el){el.textContent=message;el.classList.toggle("error",!!error)}}
function bindProductImageDropzone(){const zone=$("productImageDropzone"),input=$("productImageFiles");if(!zone||!input)return;zone.onclick=e=>{if(e.target!==input)input.click()};zone.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();input.click()}};input.onchange=async e=>{await handleProductImageFiles([...e.target.files]);input.value=""};["dragenter","dragover"].forEach(type=>zone.addEventListener(type,e=>{e.preventDefault();e.stopPropagation();zone.classList.add("drag-over")}));["dragleave","drop"].forEach(type=>zone.addEventListener(type,e=>{e.preventDefault();e.stopPropagation();zone.classList.remove("drag-over")}));zone.addEventListener("drop",async e=>{await handleProductImageFiles([...e.dataTransfer.files])})}
async function handleProductImageFiles(files){if(!files.length)return;try{files.forEach(validateProductImage);if(editingProduct?.id){setProductImageStatus("Enviando foto(s)...");const uploaded=await uploadProductImages(editingProduct.id,files);productImageDraft.push(...uploaded);await persistProductImages(editingProduct.id);productImageFiles=[];renderProductImageManager();setProductImageStatus(uploaded.length+" foto(s) adicionada(s) ao produto.");await loadProducts();editingProduct=products.find(p=>p.id===editingProduct.id)||editingProduct;productImageDraft=Array.isArray(editingProduct.images)?[...editingProduct.images]:productImageDraft;renderProductImageManager()}else{productImageFiles.push(...files);renderProductImageManager();setProductImageStatus(files.length+" foto(s) pronta(s). Salve o produto para concluir o upload.")}}catch(e){setProductImageStatus(e.message,true)}}
function renderProductImageManager(){
 const box=$("productImageManager");
 if(!box)return;
 let html="";
 productImageDraft.forEach((url,i)=>{
   html+='<div class="product-image-item" draggable="true" data-image-index="'+i+'" title="Arraste para alterar a ordem">'+
     '<img src="'+esc(url)+'" alt="" data-img-error="dim">'+
     '<span class="image-drag-handle" aria-hidden="true">↕</span>'+
     '<button type="button" class="image-remove" data-click="removeProductImage" data-args="['+i+']">×</button>'+
     '<span>'+(i===0?"CAPA":"FOTO "+(i+1))+'</span>'+
   '</div>';
 });
 productImageFiles.forEach((file,i)=>{
   const preview=URL.createObjectURL(file);
   html+='<div class="product-image-item pending" draggable="true" data-pending-index="'+i+'" title="Arraste para alterar a ordem">'+
     '<img src="'+preview+'" alt="">'+
     '<span class="image-drag-handle" aria-hidden="true">↕</span>'+
     '<span>AGUARDANDO UPLOAD</span>'+
     '<button type="button" class="image-remove" data-click="removePendingImage" data-args="['+i+']">×</button>'+
   '</div>';
 });
 setHTML(box, html||'<p class="field-help">Nenhuma foto adicionada.</p>');
 bindProductImageReorder(box);
}

function bindProductImageReorder(box){
 let draggingIndex=null;
 box.querySelectorAll("[data-image-index]").forEach(item=>{
   item.addEventListener("dragstart",e=>{
     draggingIndex=Number(item.dataset.imageIndex);
     e.dataTransfer.effectAllowed="move";
     e.dataTransfer.setData("text/plain",String(draggingIndex));
     item.classList.add("is-dragging");
   });
   item.addEventListener("dragend",()=>{
     draggingIndex=null;
     item.classList.remove("is-dragging");
     box.querySelectorAll(".drag-over").forEach(x=>x.classList.remove("drag-over"));
   });
   item.addEventListener("dragover",e=>{
     e.preventDefault();
     e.dataTransfer.dropEffect="move";
     if(draggingIndex!==null && draggingIndex!==Number(item.dataset.imageIndex)) item.classList.add("drag-over");
   });
   item.addEventListener("dragleave",()=>item.classList.remove("drag-over"));
   item.addEventListener("drop",async e=>{
     e.preventDefault();
     e.stopPropagation();
     item.classList.remove("drag-over");
     const targetIndex=Number(item.dataset.imageIndex);
     if(draggingIndex===null||draggingIndex===targetIndex)return;
     const [moved]=productImageDraft.splice(draggingIndex,1);
     productImageDraft.splice(targetIndex,0,moved);
     renderProductImageManager();
     setProductImageStatus("Ordem alterada. Salvando...");
     if(editingProduct?.id){
       try{
         await persistProductImages(editingProduct.id);
         setProductImageStatus("Ordem das fotos salva.");
         await loadProducts();
         editingProduct=products.find(p=>p.id===editingProduct.id)||editingProduct;
         productImageDraft=Array.isArray(editingProduct.images)?[...editingProduct.images]:productImageDraft;
         renderProductImageManager();
       }catch(err){
         setProductImageStatus("Não foi possível salvar a ordem: "+err.message,true);
       }
     }else{
       setProductImageStatus("Ordem alterada. Salve o produto para confirmar.");
     }
   });
 });
 
 let pendingDraggingIndex=null;
 box.querySelectorAll("[data-pending-index]").forEach(item=>{
   item.addEventListener("dragstart",e=>{
     pendingDraggingIndex=Number(item.dataset.pendingIndex);
     e.dataTransfer.effectAllowed="move";
     e.dataTransfer.setData("text/plain",String(pendingDraggingIndex));
     item.classList.add("is-dragging");
   });
   item.addEventListener("dragend",()=>{
     pendingDraggingIndex=null;
     item.classList.remove("is-dragging");
     box.querySelectorAll(".drag-over").forEach(x=>x.classList.remove("drag-over"));
   });
   item.addEventListener("dragover",e=>{
     e.preventDefault();
     e.dataTransfer.dropEffect="move";
     if(pendingDraggingIndex!==null && pendingDraggingIndex!==Number(item.dataset.pendingIndex)) item.classList.add("drag-over");
   });
   item.addEventListener("dragleave",()=>item.classList.remove("drag-over"));
   item.addEventListener("drop",e=>{
     e.preventDefault();
     e.stopPropagation();
     item.classList.remove("drag-over");
     const targetIndex=Number(item.dataset.pendingIndex);
     if(pendingDraggingIndex===null||pendingDraggingIndex===targetIndex)return;
     const [moved]=productImageFiles.splice(pendingDraggingIndex,1);
     productImageFiles.splice(targetIndex,0,moved);
     renderProductImageManager();
     setProductImageStatus("Ordem das novas fotos alterada. Salve o produto para confirmar.");
   });
 });
}
function removeProductImage(i){productImageDraft.splice(i,1);renderProductImageManager();setProductImageStatus("A foto foi removida da galeria.")}
function removePendingImage(i){productImageFiles.splice(i,1);renderProductImageManager()}
async function deleteProduct(id){const product=products.find(p=>String(p.id)===String(id));if(!product)return false;const confirmed=window.confirm("Excluir o produto \""+(product.name||"produto")+"\"?\n\nEsta ação remove o produto do catálogo. Produtos que já possuem pedidos não podem ser excluídos; nesse caso, use DESATIVAR.");if(!confirmed)return false;try{await api("/api/admin/products/"+encodeURIComponent(id),{method:"DELETE"});await loadProducts();return true}catch(e){window.alert(e.message);return false}}
async function toggleProduct(id,active){const p=products.find(x=>String(x.id)===String(id));if(!p)return;const payload={name:p.name,sku:p.sku||null,category:p.category||"bolsas",price:p.price,sale_price:p.sale_price??null,description:p.description||"",images:Array.isArray(p.images)?p.images:[],shipping_weight_kg:p.shipping_weight_kg??null,shipping_height_cm:p.shipping_height_cm??null,shipping_width_cm:p.shipping_width_cm??null,shipping_length_cm:p.shipping_length_cm??null,is_new:!!p.is_new,is_sale:!!p.is_sale,is_presale:!!p.is_presale,active:!!active};try{await api("/api/admin/products/"+encodeURIComponent(id),{method:"PUT",body:JSON.stringify(payload)});await loadProducts()}catch(e){window.alert(e.message)}}
async function deleteEditingProduct(){if(!editingProduct)return;const id=editingProduct.id;const deleted=await deleteProduct(id);if(deleted)closeProduct()}
async function uploadProductImages(productId,files=productImageFiles){const urls=[];for(const file of files){validateProductImage(file);let url="";try{url=(await uploadOptimizedPhoto(file,"product",productId)).url}catch(e){console.warn("Foto enviada sem otimizar:",e.message)}if(!url){const dataUrl=await readFileAsDataUrl(file);const d=await api("/api/admin/uploads/product-image",{method:"POST",body:JSON.stringify({product_id:productId,file_name:file.name,content_type:file.type,data_base64:dataUrl})});url=d.url}urls.push(url)}return urls}
function currentProductPayload(images=productImageDraft){return{name:$("productName").value.trim(),sku:$("productSku").value.trim()||null,category:$("productCategory").value,price:Number($("productPrice").value),sale_price:$("productSalePrice").value?Number($("productSalePrice").value):null,description:$("productDescription").value.trim(),images,shipping_weight_kg:$("productShippingWeight").value?Number($("productShippingWeight").value):null,shipping_height_cm:$("productShippingHeight").value?Number($("productShippingHeight").value):null,shipping_width_cm:$("productShippingWidth").value?Number($("productShippingWidth").value):null,shipping_length_cm:$("productShippingLength").value?Number($("productShippingLength").value):null,is_new:$("productNew").checked,is_sale:$("productSale").checked,is_presale:$("productPresale").checked,active:$("productActive").checked}}
async function persistProductImages(productId){await api("/api/admin/products/"+encodeURIComponent(productId),{method:"PUT",body:JSON.stringify(currentProductPayload(productImageDraft))})}
async function saveProduct(e){e.preventDefault();$("formError").textContent="";const id=$("productId").value;const payload=currentProductPayload(productImageDraft);if(!payload.name){$("formError").textContent="Informe o nome.";return}try{const endpoint=id?"/api/admin/products/"+encodeURIComponent(id):"/api/admin/products";const d=await api(endpoint,{method:id?"PUT":"POST",body:JSON.stringify(payload)});const pid=d.product.id;$("productId").value=pid;const uploaded=await uploadProductImages(pid);const images=[...productImageDraft,...uploaded];if(uploaded.length){await api("/api/admin/products/"+encodeURIComponent(pid),{method:"PUT",body:JSON.stringify({...payload,images})});productImageDraft=images;productImageFiles=[];renderProductImageManager()}const variants=[...document.querySelectorAll("#variantsList .variant-row")].map(r=>({id:r.dataset.id||null,color:r.querySelector(".v-color").value.trim(),sku:r.querySelector(".v-sku").value.trim()||null,stock:Math.max(0,Number(r.querySelector(".v-stock").value||0)),active:true})).filter(v=>v.color);await api("/api/admin/products/"+encodeURIComponent(pid)+"/variants",{method:"PUT",body:JSON.stringify({variants})});closeProduct();await loadProducts()}catch(e){$("formError").textContent=e.message}}
function money(v){return new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(v||0))}
function date(v){return v?new Date(v).toLocaleString("pt-BR"):"—"}
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}

async function syncPaidOrderOlist(id){
  id = id || window.currentOrderId;
  const errorBox=$("orderUpdateError");
  if(errorBox) errorBox.textContent="";
  const o=orders.find(x=>String(x.id)===String(id));
  if(!o||o.status!=="paid"){if(errorBox)errorBox.textContent="Somente pedidos pagos podem ser sincronizados com a Olist.";return}
  if(!window.confirm("Sincronizar este pedido pago com a Olist?\n\nNenhuma nova cobrança será feita."))return;
  try{
    if(errorBox)errorBox.textContent="Sincronizando com a Olist...";
    const d=await api("/api/admin/olist/sync-paid-order",{method:"POST",body:JSON.stringify({order_id:id,order_nsu:o.order_nsu||null})});
    await loadOrders();
    openOrder(id);
    const result=d.olist_sync||{};
    alert("Sincronização concluída. Pedido Olist: "+(result.numeroPedido||result.id||"criado")+".");
  }catch(e){
    if(errorBox)errorBox.textContent=e.message||"Falha na sincronização com a Olist.";
    alert(e.message||"Falha na sincronização com a Olist.");
  }
}
async function sendTrackingWhatsApp(id){const errorBox=$("orderUpdateError");if(errorBox)errorBox.textContent="";try{const d=await api(`/api/admin/orders/${encodeURIComponent(id)}/tracking-whatsapp`,{method:"POST"});await loadOrders();openOrder(id);if(d.whatsapp?.status==="not_configured")alert("WhatsApp ainda não está configurado no Render.");}catch(e){if(errorBox)errorBox.textContent=e.message}}

/* SKUs site × Olist — compara e corrige só no site */
let skuCompare=null,skuShowAll=false,skuAccept=new Set(),skuPicks=new Map();
const SKU_STATUS={ok:["IGUAL","shipped"],divergente:["DIVERGENTE","paid"],sugerido:["SUGERIDO","delivered"],sem_par:["SEM PAR NA OLIST","pending"],conflito:["CONFLITO","processing"]};
const SKU_PLURAL={ok:"IGUAIS",divergente:"DIVERGENTES",sugerido:"SUGERIDOS",sem_par:"SEM PAR NA OLIST",conflito:"CONFLITOS"};
async function compareSkus(){
  const btn=$("compareSkuButton"),box=$("skuSyncResult");
  btn.disabled=true;btn.textContent="CONSULTANDO A OLIST...";
  setHTML(box, '<p class="sku-loading">Buscando os produtos na Olist. Pode levar até um minuto.</p>');
  // A Olist é lida em passos (limite de chamadas por requisição no Cloudflare): o painel chama até fechar.
  try{
    let d=await api("/api/admin/olist/sku-compare?restart=1"),steps=0;
    while(d.partial&&steps++<25){
      setHTML(box, `<p class="sku-loading">Lendo os produtos na Olist… ${d.read||0} consultas feitas.</p>`);
      await sleep(d.wait?d.wait*1000:300);
      d=await api("/api/admin/olist/sku-compare");
    }
    if(d.partial)throw new Error("A Olist está demorando para responder. Tente de novo em alguns minutos.");
    skuCompare=d;skuAccept=new Set();skuPicks=new Map();renderSkuCompare();
  }
  catch(e){skuCompare=null;setHTML(box, '<p class="error">'+esc(e.message)+'</p>'+(/RECONECTAR OLIST/.test(e.message)?'<p><a class="secondary-link" href="/api/olist/auth" target="_blank" rel="noopener">RECONECTAR OLIST</a></p>':''))}
  finally{btn.disabled=false;btn.textContent="COMPARAR DE NOVO"}
}
function skuChangeCount(){if(!skuCompare)return 0;return (skuCompare.summary?.divergente||0)+skuAccept.size+[...skuPicks.values()].filter(Boolean).length}
function skuSituation(r){
  let extra="";
  if(r.status==="sugerido")extra=`<label class="sku-pick"><input type="checkbox" data-accept="${esc(r.key)}" ${skuAccept.has(r.key)?"checked":""}> Usar este par</label>`;
  if(r.choices&&r.choices.length)extra=`<select class="sku-choice" data-pick="${esc(r.key)}"><option value="">Escolher na Olist…</option>${r.choices.map(c=>`<option value="${esc(c.sku)}" ${skuPicks.get(r.key)===c.sku?"selected":""}>${esc(c.sku)} — ${esc(c.name)}</option>`).join("")}</select>`;
  return `<span class="badge ${SKU_STATUS[r.status][1]}">${SKU_STATUS[r.status][0]}</span>${r.note?`<small>${esc(r.note)}</small>`:""}${extra}`;
}
function renderSkuActions(){
  const box=$("skuActions");if(!box)return;const n=skuChangeCount();
  setHTML(box, n?`<p class="field-help">${n} SKU${n>1?"s":""} do site ${n>1?"passarão":"passará"} a usar o SKU da Olist: os divergentes, as sugestões marcadas e as escolhas feitas na lista. Nada é alterado na Olist.</p><button id="applySkuButton" type="button">CORRIGIR ${n} SKU${n>1?"S":""} NO SITE</button>`:`<p class="field-help">Marque "Usar este par" nas sugestões ou escolha o produto da Olist nos itens sem par para corrigir.</p>`);
  if($("applySkuButton"))$("applySkuButton").onclick=applySkuSync;
}
function renderSkuCompare(){
  const box=$("skuSyncResult");if(!skuCompare)return;
  const s=skuCompare.summary||{},rows=skuCompare.rows||[];
  const visible=rows.filter(r=>skuShowAll||r.status!=="ok");
  const chips=["ok","divergente","sugerido","sem_par","conflito"].filter(k=>s[k]).map(k=>`<span class="badge ${SKU_STATUS[k][1]}">${s[k]} ${s[k]>1?SKU_PLURAL[k]:SKU_STATUS[k][0]}</span>`).join("");
  setHTML(box, `<div class="sku-summary"><div class="sku-chips">${chips}</div><label class="sku-toggle"><input id="skuShowAll" type="checkbox" ${skuShowAll?"checked":""}> Mostrar também os iguais</label></div>
  ${visible.length?`<div class="table-wrap"><table class="table sku-table"><thead><tr><th>PRODUTO</th><th>COR</th><th>SKU NO SITE</th><th>SKU NA OLIST</th><th>SITUAÇÃO</th></tr></thead><tbody>${visible.map(r=>`<tr class="sku-${r.status}"><td>${esc(r.product_name)}${r.product_active?"":' <span class="chip chip-off">INATIVO</span>'}</td><td>${r.kind==="produto"?'<span class="sku-kind">produto</span>':esc(r.color||"—")}</td><td><code>${esc(r.site_sku||"—")}</code></td><td>${r.olist_sku?`<code>${esc(r.olist_sku)}</code>`:"—"}${r.olist_name?`<small>${esc(r.olist_name)}</small>`:""}</td><td>${skuSituation(r)}</td></tr>`).join("")}</tbody></table></div>`:'<p class="sku-empty">Tudo certo: os SKUs do site estão iguais aos da Olist.</p>'}
  <div class="sku-actions" id="skuActions"></div>`);
  $("skuShowAll").onchange=e=>{skuShowAll=e.target.checked;renderSkuCompare()};
  box.querySelectorAll("[data-accept]").forEach(el=>el.onchange=()=>{el.checked?skuAccept.add(el.dataset.accept):skuAccept.delete(el.dataset.accept);renderSkuActions()});
  box.querySelectorAll("[data-pick]").forEach(el=>el.onchange=()=>{el.value?skuPicks.set(el.dataset.pick,el.value):skuPicks.delete(el.dataset.pick);renderSkuActions()});
  renderSkuActions();
}
async function applySkuSync(){
  if(!skuCompare)return;const n=skuChangeCount();if(!n)return;
  if(!window.confirm(`Atualizar ${n} SKU${n>1?"s":""} no site para ficar${n>1?"em iguais":" igual"} à Olist?\n\nNada será alterado na Olist.`))return;
  const btn=$("applySkuButton");btn.disabled=true;btn.textContent="CORRIGINDO...";
  try{
    // Muitas correções vão em partes: o servidor devolve quantas faltam e o painel chama de novo.
    const body=JSON.stringify({token:skuCompare.token,accept:[...skuAccept],picks:Object.fromEntries([...skuPicks].filter(([,v])=>v))});
    const d={updated:0,skipped:[],changes:[]};let part,rounds=0;
    do{part=await api("/api/admin/olist/sku-sync",{method:"POST",body});d.updated+=part.updated||0;d.changes.push(...(part.changes||[]));if(!part.remaining)d.skipped=part.skipped||[]}
    while(part.remaining&&rounds++<10);
    const pickedProducts=[...skuPicks.keys()].some(k=>k.startsWith("p:"));
    skuCompare=null;skuAccept=new Set();skuPicks=new Map();
    const skipped=(d.skipped||[]).length;
    setHTML($("skuSyncResult"), `<div class="sku-done"><p><strong>${d.updated} SKU${d.updated===1?"":"s"} corrigido${d.updated===1?"":"s"} no site.</strong>${skipped?` ${skipped} não alterado${skipped>1?"s":""}.`:""}${pickedProducts?" Compare de novo para conferir as cores dos produtos que você escolheu.":""}</p>${(d.changes||[]).length?`<ul>${d.changes.map(c=>`<li>${esc(c.product_name)}${c.color?" · "+esc(c.color):""}: <code>${esc(c.from||"—")}</code> → <code>${esc(c.to)}</code></li>`).join("")}</ul>`:""}${skipped?`<ul class="sku-skipped">${d.skipped.map(r=>`<li>${esc(r.product_name)}${r.color?" · "+esc(r.color):""}: ${esc(r.reason)}</li>`).join("")}</ul>`:""}</div>`);
    await loadProducts();
  }catch(e){btn.disabled=false;btn.textContent="TENTAR DE NOVO";alert(e.message)}
}

/* Olist → site: estoque, preço/promoção e cores (a Olist manda) */
const OLIST_CHANGE_LABEL={estoque:"Estoque",preco:"Preço",cor:"Nome da cor",nova_cor:"Cor nova"};
let olistConference=null,olistShowAll=false;
function olistChangeItem(x){
  const what=x.what||"estoque";
  return `<li>${esc(x.product)}${x.color?" · "+esc(x.color):""}${x.sku?` <code>${esc(x.sku)}</code>`:""} — ${OLIST_CHANGE_LABEL[what]||esc(what)}: ${esc(x.from===""?"—":x.from)} → <strong>${esc(x.to)}</strong></li>`;
}
function renderStockSync(d){
  const box=$("stockSyncStatus");if(!box)return;
  if(d&&d.enabled===false){setHTML(box, '<p class="field-help">A integração com a Olist está desligada neste servidor.</p>');return}
  if(d&&d.settings){const p=$("olistSyncPrices"),c=$("olistSyncColors");if(p)p.checked=d.settings.prices!==false;if(c)c.checked=d.settings.colors!==false}
  const last=d&&d.last,cycle=d&&d.cycle;
  const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
  const progress=cycle?`<p class="stock-sync-line"><strong>Conferência em andamento:</strong> começou ${esc(date(cycle.started_at))} (${cycle.trigger==="painel"?"pelo painel":"automática"}) · ${plural(cycle.products||0,"produto conferido","produtos conferidos")} até agora${(cycle.changes||[]).length?` · ${plural(cycle.changes.length,"alteração","alterações")}`:""}</p>`:"";
  if(!last){setHTML(box, progress||'<p class="field-help">Ainda não rodou. A primeira conferência começa em instantes, ou clique em SINCRONIZAR AGORA.</p>');return}
  const when=date(last.finished_at||last.started_at),how=last.trigger==="painel"?"pelo painel":"automática";
  const changes=last.changes||[],missing=last.not_found||[],dups=last.duplicates||[];
  setHTML(box, `${progress}<p class="stock-sync-line"><strong>Última conferência completa:</strong> ${esc(when)} (${how}) · ${plural(last.products||0,"produto","produtos")} · ${plural(last.checked||0,"cor conferida","cores conferidas")} · ${plural(changes.length,"alteração no site","alterações no site")}${missing.length?` · ${plural(missing.length,"cor sem SKU na Olist","cores sem SKU na Olist")}`:""}${last.errors?` · ${last.errors} com erro`:""}</p>
  ${last.error?`<p class="error">${esc(last.error)}${/RECONECTAR/.test(last.error)?' <a class="secondary-link" href="/api/olist/auth" target="_blank" rel="noopener">RECONECTAR OLIST</a>':""}</p>`:""}
  ${changes.length?`<details class="stock-sync-missing" open><summary>O que a última conferência mudou no site</summary><ul class="stock-sync-list">${changes.slice().reverse().map(olistChangeItem).join("")}</ul></details>`:""}
  ${dups.length?`<details class="stock-sync-missing" open><summary>SKU repetido em duas peças do site (não são conferidas até corrigir o SKU de uma delas)</summary><ul>${dups.map(x=>`<li>${esc(x.product)}${x.color?" · "+esc(x.color):""} <code>${esc(x.sku)}</code></li>`).join("")}</ul></details>`:""}
  ${missing.length?`<details class="stock-sync-missing"><summary>Cores do site com SKU que não existe na Olist (não são conferidas)</summary><ul>${missing.map(x=>`<li>${esc(x.product)}${x.color?" · "+esc(x.color):""} <code>${esc(x.sku)}</code></li>`).join("")}</ul></details>`:""}`);
}
function olistVariantStatus(v){
  const o=v.olist;
  if(!o)return["aguardando","AGUARDANDO CONFERÊNCIA","pending"];
  if(o.st==="pre_venda")return["pre_venda","PRÉ-VENDA · ESTOQUE DO PAINEL","delivered"];
  if(o.st==="sem_olist")return["sem_olist","SKU NÃO ACHADO NA OLIST","processing"];
  if(o.st==="sku_repetido")return["repetido","SKU REPETIDO NO SITE","processing"];
  if(o.st==="erro")return["erro","SEM ESTOQUE NA RESPOSTA","processing"];
  if(o.target!==null&&o.target!==undefined&&v.stock!==o.target)return["diferente","DIFERENTE · CORRIGE NA PRÓXIMA RODADA","paid"];
  return["igual","IGUAL","shipped"];
}
function olistPriceStatus(p){
  const o=p.olist;
  if(!o)return["aguardando","AGUARDANDO","pending",""];
  if(o.st==="pre_venda")return["igual","PRÉ-VENDA · PREÇO DO PAINEL","delivered","Em pré-venda a Olist não mexe neste produto."];
  if(!o.price)return["sem_preco",o.st==="sku_repetido"?"SKU REPETIDO NO SITE":o.st==="sem_olist"?"NÃO ACHADO NA OLIST":"SEM PREÇO NA OLIST","processing",""];
  if(o.st==="aviso")return["aviso","CONFERIR","processing",o.note||""];
  const same=(a,b)=>a!==null&&b!==null&&Math.abs(Number(a)-Number(b))<0.005;
  if(o.st==="sale_site"&&p.sale_price!==null)return["igual","SALE DO SITE · PREÇOS MANTIDOS","shipped","Os preços da SALE do site não são trocados pela Olist."];
  const equal=same(p.price,o.price)&&(o.promo?same(p.sale_price,o.promo):p.sale_price===null);
  if(equal)return["igual","IGUAL","shipped",""];
  if(o.st==="desligado")return["desligado","DIFERENTE · ATUALIZAÇÃO DE PREÇO DESLIGADA","paid",""];
  return["diferente","DIFERENTE · CORRIGE NA PRÓXIMA RODADA","paid",""];
}
function renderOlistConference(){
  const box=$("olistConference");if(!box||!olistConference)return;
  const priceText=(price,sale)=>sale!==null&&sale!==undefined?`${money(price)} → <strong>${money(sale)}</strong>`:money(price);
  const count={igual:0,diferente:0,outros:0};
  const products=olistConference.map(p=>{
    const priceSt=olistPriceStatus(p);
    const variants=p.variants.map(v=>({v,st:olistVariantStatus(v)}));
    variants.forEach(x=>count[x.st[0]==="igual"?"igual":x.st[0]==="diferente"?"diferente":"outros"]++);
    const allEqual=priceSt[0]==="igual"&&variants.every(x=>x.st[0]==="igual");
    return {p,priceSt,variants,allEqual};
  });
  const visible=products.filter(x=>olistShowAll||!x.allEqual);
  const head=`<div class="sku-summary"><div class="sku-chips"><span class="badge shipped">${count.igual} ${count.igual===1?"COR IGUAL":"CORES IGUAIS"}</span>${count.diferente?`<span class="badge paid">${count.diferente} ${count.diferente===1?"DIFERENTE":"DIFERENTES"}</span>`:""}${count.outros?`<span class="badge processing">${count.outros} PARA CONFERIR</span>`:""}</div><label class="sku-toggle"><input id="olistShowAll" type="checkbox" ${olistShowAll?"checked":""}> Mostrar também os produtos iguais</label></div>`;
  const rows=visible.map(({p,priceSt,variants})=>{
    const olistPrice=p.olist&&p.olist.price?priceText(p.olist.price,p.olist.promo):"—";
    return `<tr class="olist-product-row"><td colspan="3"><strong>${esc(p.name)}</strong></td><td>Site ${priceText(p.price,p.sale_price)}</td><td>Olist ${olistPrice}</td><td><span class="badge ${priceSt[2]}">${priceSt[1]}</span>${priceSt[3]?`<small>${esc(priceSt[3])}</small>`:""}</td></tr>`+
      variants.map(({v,st})=>{
        const o=v.olist,olist=o&&o.available!==null&&o.available!==undefined?String(o.available):"—";
        const note=o&&o.waiting?`<small>${o.waiting} vendida${o.waiting>1?"s":""} no site ainda não baixada${o.waiting>1?"s":""} na Olist: o site fica com ${o.target}.</small>`:"";
        return `<tr class="olist-variant-row olist-${st[0]}"><td></td><td>${esc(v.color)}</td><td><code>${esc(v.sku||"—")}</code></td><td>Site <strong>${v.stock}</strong></td><td>Olist <strong>${olist}</strong>${note}</td><td><span class="badge ${st[2]}">${st[1]}</span></td></tr>`;
      }).join("");
  }).join("");
  setHTML(box, `<h3 class="olist-conference-title">Conferência site × Olist</h3>${head}${visible.length?`<div class="table-wrap"><table class="table sku-table olist-table"><thead><tr><th>PRODUTO</th><th>COR</th><th>SKU</th><th>SITE</th><th>OLIST</th><th>SITUAÇÃO</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="sku-empty">Tudo igual entre o site e a Olist na última conferência.</p>'}`);
  $("olistShowAll").onchange=e=>{olistShowAll=e.target.checked;renderOlistConference()};
}
async function loadStockSyncStatus(){
  const box=$("stockSyncStatus");if(!box)return;
  try{const d=await api("/api/admin/olist/stock-sync?conference=1");renderStockSync(d);if(Array.isArray(d.conference)){olistConference=d.conference;renderOlistConference()}}
  catch(e){setHTML(box, '<p class="error">'+esc(e.message)+'</p>')}
}
async function saveOlistSyncSettings(){
  const p=$("olistSyncPrices"),c=$("olistSyncColors");
  const msg=$("olistSyncOptionsMsg");
  try{await api("/api/admin/olist/sync-settings",{method:"PUT",body:JSON.stringify({prices:p.checked,colors:c.checked})});if(msg)msg.textContent="Salvo. Vale a partir da próxima rodada."}
  catch(e){if(msg)msg.textContent=e.message;loadStockSyncStatus()}
}
async function runStockSync(){
  const btn=$("stockSyncButton"),box=$("stockSyncStatus");
  btn.disabled=true;btn.textContent="CONFERINDO NA OLIST...";
  setHTML(box, '<p class="sku-loading">Conferindo cada produto na Olist, em lotes. Pode levar alguns minutos.</p>');
  // Cada chamada confere um lote; a primeira começa uma rodada nova e as seguintes continuam a mesma.
  try{
    let id="",d=null,rounds=0;
    do{
      d=await api("/api/admin/olist/stock-sync",{method:"POST",body:JSON.stringify(id?{cycle:id}:{restart:true})});
      if(d.cycle_id)id=d.cycle_id;
      if(!d.done){
        if(d.waiting)setHTML(box, '<p class="sku-loading">A conferência automática está rodando um lote. Aguardando para continuar…</p>');
        else renderStockSync({enabled:true,last:d.last,cycle:d.cycle});
        await sleep(d.waiting?5000:500);
      }
    }while(!d.done&&rounds++<80);
    await loadStockSyncStatus();await loadProducts();loadStockMovements();
  }
  catch(e){setHTML(box, '<p class="error">'+esc(e.message)+'</p>');setTimeout(loadStockSyncStatus,1500)}
  finally{btn.disabled=false;btn.textContent="SINCRONIZAR AGORA"}
}

/* Saudação do topo (antes era um script dentro do admin.html; a CSP não aceita mais). */
(function(){const hour=new Date().getHours(),title=$("welcomeTitle"),day=$("welcomeDate");if(title)title.textContent=(hour<12?"Bom dia":hour<18?"Boa tarde":"Boa noite")+".";if(day)day.textContent=new Date().toLocaleDateString("pt-BR",{weekday:"long",day:"numeric",month:"long"}).toUpperCase()})();

/* Botões montados pelo painel (data-click em vez de onclick). */
/* =====================================================
   CUPONS
   Porcentagem ou valor em R$, com validade e limite de pessoas
   (1 = cupom único). O uso conta enquanto o pedido aguarda pagamento
   ou está pago; pedido expirado ou cancelado devolve o cupom.
===================================================== */
const COUPON_PAID_STATUSES=["paid","processing","shipped","delivered"];
function couponHolds(r){const st=r.orders?.status;return st==="pending"||COUPON_PAID_STATUSES.includes(st)}
function couponPeople(c){return new Set((c.coupon_redemptions||[]).filter(couponHolds).map(r=>r.customer_cpf)).size}
function couponDiscountText(c){return c.discount_type==="percent"?Number(c.discount_value).toLocaleString("pt-BR",{maximumFractionDigits:2})+"% OFF":money(c.discount_value)+" OFF"}
function couponState(c){const now=Date.now();if(!c.active)return["INATIVO","expired"];if(c.starts_at&&new Date(c.starts_at).getTime()>now)return["AGENDADO","pending"];if(c.expires_at&&new Date(c.expires_at).getTime()<=now)return["EXPIRADO","expired"];if(couponPeople(c)>=c.max_uses)return["ESGOTADO","shipped"];return["ATIVO","paid"]}
function couponUseLabel(r){const st=r.orders?.status;if(COUPON_PAID_STATUSES.includes(st))return["USADO","paid"];if(st==="pending")return["AGUARDANDO PAGAMENTO","pending"];if(st==="cancelled")return["LIBERADO · PEDIDO CANCELADO","expired"];return["LIBERADO · PEDIDO NÃO PAGO","expired"]}
function couponLocalInput(v){if(!v)return "";const d=new Date(v),p=n=>String(n).padStart(2,"0");return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`}
function couponIso(v){return v?new Date(v).toISOString():null}
function maskCpf(v){const d=String(v||"").replace(/\D/g,"");return d.length===11?d.slice(0,3)+"."+d.slice(3,6)+"."+d.slice(6,9)+"-"+d.slice(9):d||"—"}
async function loadCoupons(){try{$("couponsError").textContent="";const d=await api("/api/admin/coupons");coupons=d.coupons||[];couponsLoaded=true;renderCoupons()}catch(e){$("couponsError").textContent=e.message}}
function renderCoupons(){
  const box=$("couponsList");if(!box)return;
  if(!coupons.length){setHTML(box,`<div class="panel"><p>${couponsLoaded?"Nenhum cupom cadastrado ainda.":"Carregando cupons…"}</p></div>`);return}
  setHTML(box,coupons.map(c=>{
    const [state,stateClass]=couponState(c),uses=c.coupon_redemptions||[],people=couponPeople(c);
    const validity=c.starts_at||c.expires_at?`Válido ${c.starts_at?"de "+date(c.starts_at)+" ":""}${c.expires_at?"até "+date(c.expires_at):"sem data de fim"}`:"Sem data de validade";
    const rows=uses.map(r=>{const [label,cls]=couponUseLabel(r),o=r.orders||{};return `<tr><td>${esc(r.customer_name||"—")}</td><td>${esc(maskCpf(r.customer_cpf))}</td><td>${esc(r.customer_email||"—")}</td><td>${o.id?`<button class="link-button" data-click="openOrder" data-args="${esc(JSON.stringify([o.id]))}">${esc(o.order_code?"MONTÊ-"+o.order_code:(o.order_nsu||"—"))}</button>`:"—"}</td><td>-${money(r.discount_amount)}</td><td>${o.total!=null?money(o.total):"—"}</td><td>${date(r.created_at)}</td><td><span class="badge ${cls}">${label}</span></td></tr>`}).join("");
    return `<article class="panel coupon-card${c.active?"":" is-inactive"}">
      <div class="coupon-card-head"><div><h3 class="coupon-code">${esc(c.code)}</h3><p class="meta">${esc(couponDiscountText(c))} nas peças · ${c.max_uses===1?"cupom único (1 pessoa)":esc(c.max_uses)+" pessoas, 1 vez cada"} · ${esc(validity)}</p>${c.note?`<p class="field-help">${esc(c.note)}</p>`:""}</div>
      <div class="coupon-card-side"><span class="badge ${stateClass}">${state}</span><span class="coupon-uses"><strong>${people}</strong> de ${esc(c.max_uses)} ${c.max_uses===1?"uso":"pessoas"}</span></div></div>
      <div class="coupon-card-actions"><button class="secondary small-button" data-click="editCoupon" data-args="${esc(JSON.stringify([c.id]))}">EDITAR</button><button class="secondary small-button" data-click="toggleCoupon" data-args="${esc(JSON.stringify([c.id,!c.active]))}">${c.active?"DESATIVAR":"ATIVAR"}</button>${uses.length?"":`<button class="secondary small-button danger-button" data-click="deleteCoupon" data-args="${esc(JSON.stringify([c.id]))}">EXCLUIR</button>`}</div>
      <div class="coupon-uses-table table-wrap">${uses.length?`<table class="table"><thead><tr><th>CLIENTE</th><th>CPF</th><th>E-MAIL</th><th>PEDIDO</th><th>DESCONTO</th><th>TOTAL PAGO</th><th>DATA</th><th>SITUAÇÃO</th></tr></thead><tbody>${rows}</tbody></table>`:`<p class="field-help">Ninguém usou este cupom ainda.</p>`}</div>
    </article>`}).join(""))
}
function updateCouponValueLabel(){const percent=$("couponType").value==="percent";$("couponValueLabel").textContent=percent?"Desconto (%)":"Desconto (R$)";$("couponValue").max=percent?"100":"";$("couponValue").placeholder=percent?"Ex.: 10":"Ex.: 50,00"}
function resetCouponForm(){$("couponForm").reset();$("couponId").value="";$("couponMaxUses").value="1";$("couponActive").checked=true;["couponCodeInput","couponType","couponValue"].forEach(id=>$(id).disabled=false);$("couponFormTitle").textContent="Novo cupom";$("saveCouponButton").textContent="CRIAR CUPOM";$("cancelCouponEdit").classList.add("hidden");$("couponFormError").textContent="";updateCouponValueLabel();closeDrawer("couponFormPanel")}
function editCoupon(id){const c=coupons.find(x=>String(x.id)===String(id));if(!c)return;const used=(c.coupon_redemptions||[]).length>0;$("couponId").value=c.id;$("couponCodeInput").value=c.code;$("couponType").value=c.discount_type;$("couponValue").value=Number(c.discount_value);$("couponMaxUses").value=c.max_uses;$("couponStartsAt").value=couponLocalInput(c.starts_at);$("couponExpiresAt").value=couponLocalInput(c.expires_at);$("couponNote").value=c.note||"";$("couponActive").checked=!!c.active;["couponCodeInput","couponType","couponValue"].forEach(x=>$(x).disabled=used);updateCouponValueLabel();$("couponFormTitle").textContent="Editar cupom "+c.code;$("saveCouponButton").textContent="SALVAR ALTERAÇÕES";$("cancelCouponEdit").classList.remove("hidden");$("couponFormError").textContent=used?"Este cupom já foi usado: o código e o desconto ficam como estão. Você pode mudar a validade, o limite e se está ativo.":"";openDrawer("couponFormPanel");$("couponFormPanel").scrollIntoView({behavior:"smooth",block:"start"})}
async function saveCoupon(e){
  e.preventDefault();$("couponFormError").textContent="";
  const id=$("couponId").value,body={max_uses:Number($("couponMaxUses").value),starts_at:couponIso($("couponStartsAt").value),expires_at:couponIso($("couponExpiresAt").value),note:$("couponNote").value.trim(),active:$("couponActive").checked};
  if(!$("couponCodeInput").disabled)Object.assign(body,{code:$("couponCodeInput").value.replace(/\s+/g,"").toUpperCase(),discount_type:$("couponType").value,discount_value:Number(String($("couponValue").value).replace(",","."))});
  if(body.expires_at&&!id&&new Date(body.expires_at).getTime()<=Date.now()){$("couponFormError").textContent="A data de fim já passou.";return}
  const button=$("saveCouponButton");button.disabled=true;
  try{await api(id?"/api/admin/coupons/"+encodeURIComponent(id):"/api/admin/coupons",{method:id?"PATCH":"POST",body:JSON.stringify(body)});resetCouponForm();await loadCoupons()}
  catch(err){$("couponFormError").textContent=err.message}
  finally{button.disabled=false}
}
async function toggleCoupon(id,active){try{await api("/api/admin/coupons/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({active})});await loadCoupons()}catch(e){window.alert(e.message)}}
async function deleteCoupon(id){const c=coupons.find(x=>String(x.id)===String(id));if(!window.confirm("Excluir o cupom "+(c?.code||"")+"? Esta ação não pode ser desfeita."))return;try{await api("/api/admin/coupons/"+encodeURIComponent(id),{method:"DELETE"});if(String($("couponId").value)===String(id))resetCouponForm();await loadCoupons()}catch(e){window.alert(e.message)}}

/* =====================================================
   PROMOÇÕES DE PRESENTE
   A cliente ganha uma peça da categoria (à escolha dela) quando as
   peças da compra somam o valor mínimo; o frete não conta. Entram e
   saem do ar sozinhas nas datas; "Iniciar agora" e "Encerrar agora"
   mudam as datas na hora.
===================================================== */
const PROMO_CATEGORY_LABELS={cintos:"Cinto",acessorios:"Acessório",bolsas:"Bolsa"};
function promotionState(p){const now=Date.now();if(!p.active)return["PAUSADA","expired"];if(new Date(p.starts_at).getTime()>now)return["AGENDADA","pending"];if(new Date(p.ends_at).getTime()<=now)return["ENCERRADA","expired"];return["NO AR","paid"]}
async function loadPromotions(){try{$("promotionsError").textContent="";const d=await api("/api/admin/promotions");promotions=d.promotions||[];promotionsLoaded=true;renderBenefits(d.benefits);renderTopBar(d.top_bar);renderPromotions()}catch(e){$("promotionsError").textContent=e.message}}
// Barra do topo do site: o aviso escrito aqui ou, em branco, o automático (aviso da promoção
// de presente no ar, ou o frete grátis e o Pix), como o site escolhe.
const TOP_BAR_MAX=90,TOP_BAR_MAX_MESSAGES=6;
let topBarPreviewTimer=null,topBarPreviewIndex=0;
// Lista de campos (um por aviso). Sempre há pelo menos um campo, mesmo vazio.
function topBarInputs(){return [...document.querySelectorAll("#topBarList input")]}
function topBarTypedMessages(){return topBarInputs().map(i=>i.value.replace(/\s+/g," ").trim()).filter(Boolean)}
function renderTopBarList(messages){
  const box=$("topBarList");if(!box)return;
  const list=messages.length?messages:[""];
  setHTML(box,list.map((text,i)=>`<div class="top-bar-row"><label>Aviso ${i+1}<input maxlength="${TOP_BAR_MAX}" value="${esc(text)}" placeholder="Ex.: BLACK FRIDAY: 15% OFF EM TODA A LOJA"></label><span class="field-help top-bar-count"></span><button type="button" class="secondary top-bar-remove" data-index="${i}" aria-label="Remover aviso ${i+1}">REMOVER</button></div>`).join(""));
  box.querySelectorAll("input").forEach(input=>{input.oninput=updateTopBarPreview});
  box.querySelectorAll(".top-bar-remove").forEach(button=>{button.onclick=()=>{const current=topBarInputs().map(i=>i.value);current.splice(Number(button.dataset.index),1);renderTopBarList(current);updateTopBarPreview();$("topBarMessage").textContent="Aviso removido. Clique em SALVAR BARRA DO TOPO para confirmar."}});
  updateTopBarPreview();
}
function addTopBarMessage(){const current=topBarInputs().map(i=>i.value);if(current.length>=TOP_BAR_MAX_MESSAGES)return;current.push("");renderTopBarList(current);const inputs=topBarInputs();inputs[inputs.length-1].focus()}
function renderTopBar(t){if(!t)return;renderTopBarList(Array.isArray(t.messages)?t.messages:(t.text?[t.text]:[]));$("topBarMessage").textContent=""}
// Sem avisos do painel, o site mostra os das promoções no ar ou o frete grátis e o Pix.
function topBarAutomatic(){const now=Date.now();const banners=[...new Set(promotions.filter(x=>x.active&&x.banner_text&&Date.parse(x.starts_at)<=now&&now<Date.parse(x.ends_at)).sort((a,b)=>Number(a.min_subtotal)-Number(b.min_subtotal)).map(x=>x.banner_text.trim()))];if(banners.length)return{texts:banners,note:`Como aparece no site (automático: ${banners.length>1?"avisos das promoções no ar":"aviso da promoção no ar"})`};const b=storeBenefitsData,parts=[];if(b?.free_shipping?.enabled)parts.push(`FRETE GRÁTIS EM FORTALEZA E REGIÃO A PARTIR DE ${money(b.free_shipping.min_subtotal).replace(",00","")}`);if(b?.pix_discount?.enabled)parts.push(`${String(Number(b.pix_discount.percent)).replace(".",",")}% OFF NO PIX`);return{texts:[parts.join(" · ")],note:parts.length?"Como aparece no site (automático: frete grátis e Pix)":"Como aparece no site (automático: barra vazia)"}}
function updateTopBarPreview(){
  if(!$("topBarList"))return;
  const typed=topBarTypedMessages(),auto=typed.length?null:topBarAutomatic(),texts=typed.length?typed:auto.texts;
  topBarInputs().forEach(input=>{const count=input.closest(".top-bar-row")?.querySelector(".top-bar-count");if(count)count.textContent=`${input.value.length}/${TOP_BAR_MAX}`});
  $("addTopBarButton").hidden=topBarInputs().length>=TOP_BAR_MAX_MESSAGES;
  $("topBarPreviewNote").textContent=typed.length?(typed.length>1?`Como aparece no site (${typed.length} avisos, um de cada vez)`:"Como aparece no site"):auto.note;
  // Prévia igual ao site: com mais de um aviso, alterna (aqui, a cada 2,5 s).
  clearInterval(topBarPreviewTimer);topBarPreviewIndex=Math.min(topBarPreviewIndex,texts.length-1);
  const show=()=>{$("topBarPreview").textContent=texts[topBarPreviewIndex]||""};show();
  if(texts.length>1)topBarPreviewTimer=setInterval(()=>{topBarPreviewIndex=(topBarPreviewIndex+1)%texts.length;show()},2500);
}
async function saveTopBar(e){e?.preventDefault();const button=$("saveTopBarButton");button.disabled=true;$("clearTopBarButton").disabled=true;$("topBarMessage").textContent="";try{const d=await api("/api/admin/top-bar",{method:"PUT",body:JSON.stringify({messages:topBarTypedMessages()})});renderTopBar(d.top_bar);const n=d.top_bar?.messages?.length||0;$("topBarMessage").textContent=n?`Salvo (${n} aviso${n>1?"s":""}). O site atualiza em até 1 minuto.`:"Salvo: a barra voltou ao automático. O site atualiza em até 1 minuto."}catch(err){$("topBarMessage").textContent=err.message}finally{button.disabled=false;$("clearTopBarButton").disabled=false}}
function clearTopBar(){renderTopBarList([]);saveTopBar()}
// Frete grátis e desconto do Pix: valem o tempo todo, até desligar.
function renderBenefits(b){if(!b)return;storeBenefitsData=b;updateTopBarPreview();$("benefitShippingOn").checked=!!b.free_shipping?.enabled;$("benefitShippingMin").value=Number(b.free_shipping?.min_subtotal||0);$("benefitPixOn").checked=!!b.pix_discount?.enabled;$("benefitPixPercent").value=Number(b.pix_discount?.percent||0);$("benefitsMessage").textContent=""}
async function saveBenefits(e){e.preventDefault();const button=$("saveBenefitsButton");button.disabled=true;$("benefitsMessage").textContent="";try{const d=await api("/api/admin/store-benefits",{method:"PUT",body:JSON.stringify({free_shipping:{enabled:$("benefitShippingOn").checked,min_subtotal:Number(String($("benefitShippingMin").value).replace(",","."))},pix_discount:{enabled:$("benefitPixOn").checked,percent:Number(String($("benefitPixPercent").value).replace(",","."))}})});renderBenefits(d.benefits);$("benefitsMessage").textContent="Salvo. O site atualiza em até 1 minuto."}catch(err){$("benefitsMessage").textContent=err.message}finally{button.disabled=false}}
function renderPromotions(){
  const box=$("promotionsList");if(!box)return;
  if(!promotions.length){setHTML(box,`<div class="panel"><p>${promotionsLoaded?"Nenhuma promoção cadastrada ainda.":"Carregando promoções…"}</p></div>`);return}
  setHTML(box,promotions.map(p=>{
    const [state,cls]=promotionState(p),list=p.orders||[],paid=list.filter(o=>COUPON_PAID_STATUSES.includes(o.status)),paidGifts=paid.reduce((sum,o)=>sum+(o.gifts||[]).reduce((n,g)=>n+(Number(g.quantity)||1),0),0);
    const rows=list.map(o=>`<tr><td><button class="link-button" data-click="openOrder" data-args="${esc(JSON.stringify([o.id]))}">${esc(o.order_code?"MONTÊ-"+o.order_code:(o.order_nsu||"—"))}</button></td><td>${esc(o.customer_name||"—")}</td><td>${esc((o.gifts||[]).map(g=>(Number(g.quantity)>1?g.quantity+"× ":"")+g.name+(g.color?" ("+g.color+")":"")).join(", ")||"—")}</td><td>${money(o.total)}</td><td>${date(o.created_at)}</td><td><span class="badge ${esc(o.status||"pending")}">${statusLabel(o.status)}</span></td></tr>`).join("");
    const live=state==="NO AR",scheduled=state==="AGENDADA";
    return `<article class="panel coupon-card${p.active?"":" is-inactive"}">
      <div class="coupon-card-head"><div><h3 class="promo-name">${esc(p.name)}</h3><p class="meta">Presente: ${esc(PROMO_CATEGORY_LABELS[p.gift_category]||p.gift_category)} à escolha · ${p.gift_every?`um a cada ${money(p.min_subtotal)} em peças · ${p.max_gifts?`até ${esc(p.max_gifts)} por pedido`:"sem limite por pedido"}`:`compras a partir de ${money(p.min_subtotal)} em peças`} · ${esc(date(p.starts_at))} até ${esc(date(p.ends_at))}</p>${p.banner_text?`<p class="field-help">Barra do topo: “${esc(p.banner_text)}”</p>`:""}${p.terms_text?`<p class="field-help">Regra do presente: “${esc(p.terms_text)}”</p>`:""}</div>
      <div class="coupon-card-side"><span class="badge ${cls}">${state}</span><span class="coupon-uses"><strong>${paidGifts}</strong> presente${paidGifts===1?"":"s"} em pedidos pagos</span></div></div>
      <div class="coupon-card-actions"><button class="secondary small-button" data-click="editPromotion" data-args="${esc(JSON.stringify([p.id]))}">EDITAR</button>${scheduled&&p.active?`<button class="secondary small-button" data-click="startPromotionNow" data-args="${esc(JSON.stringify([p.id]))}">INICIAR AGORA</button>`:""}${live&&p.active?`<button class="secondary small-button" data-click="endPromotionNow" data-args="${esc(JSON.stringify([p.id]))}">ENCERRAR AGORA</button>`:""}<button class="secondary small-button" data-click="togglePromotion" data-args="${esc(JSON.stringify([p.id,!p.active]))}">${p.active?"PAUSAR":"REATIVAR"}</button><button class="secondary small-button danger-button" data-click="deletePromotion" data-args="${esc(JSON.stringify([p.id]))}">EXCLUIR</button></div>
      <div class="coupon-uses-table table-wrap">${list.length?`<table class="table"><thead><tr><th>PEDIDO</th><th>CLIENTE</th><th>PRESENTE ESCOLHIDO</th><th>TOTAL</th><th>DATA</th><th>SITUAÇÃO</th></tr></thead><tbody>${rows}</tbody></table>`:`<p class="field-help">Nenhum pedido com o presente desta promoção ainda.</p>`}</div>
    </article>`}).join(""))
}
// O máximo de presentes só vale na promoção "um presente a cada valor mínimo".
function syncPromoEvery(){const every=$("promoEvery").checked;$("promoMaxGifts").disabled=!every;if(!every)$("promoMaxGifts").value=""}
function resetPromotionForm(){$("promoForm").reset();$("promoId").value="";$("promoActive").checked=true;syncPromoEvery();$("promoFormTitle").textContent="Nova promoção";$("savePromoButton").textContent="CRIAR PROMOÇÃO";$("cancelPromoEdit").classList.add("hidden");$("promoFormError").textContent="";closeDrawer("promoFormPanel")}
function editPromotion(id){const p=promotions.find(x=>String(x.id)===String(id));if(!p)return;$("promoId").value=p.id;$("promoName").value=p.name;$("promoCategory").value=p.gift_category;$("promoMin").value=Number(p.min_subtotal);$("promoEvery").checked=p.gift_every===true;$("promoMaxGifts").value=p.max_gifts||"";syncPromoEvery();$("promoStartsAt").value=couponLocalInput(p.starts_at);$("promoEndsAt").value=couponLocalInput(p.ends_at);$("promoBanner").value=p.banner_text||"";$("promoTerms").value=p.terms_text||"";$("promoActive").checked=!!p.active;$("promoFormTitle").textContent="Editar promoção";$("savePromoButton").textContent="SALVAR ALTERAÇÕES";$("cancelPromoEdit").classList.remove("hidden");$("promoFormError").textContent="";showSubtab("promotions","gifts");openDrawer("promoFormPanel");$("promoFormPanel").scrollIntoView({behavior:"smooth",block:"start"})}
async function savePromotion(e){
  e.preventDefault();$("promoFormError").textContent="";
  const id=$("promoId").value,body={name:$("promoName").value.trim(),gift_category:$("promoCategory").value,min_subtotal:Number(String($("promoMin").value).replace(",",".")),gift_every:$("promoEvery").checked,max_gifts:$("promoEvery").checked&&String($("promoMaxGifts").value).trim()?Number($("promoMaxGifts").value):null,starts_at:couponIso($("promoStartsAt").value),ends_at:couponIso($("promoEndsAt").value),banner_text:$("promoBanner").value.trim(),terms_text:$("promoTerms").value.trim(),active:$("promoActive").checked};
  const button=$("savePromoButton");button.disabled=true;
  try{await api(id?"/api/admin/promotions/"+encodeURIComponent(id):"/api/admin/promotions",{method:id?"PATCH":"POST",body:JSON.stringify(body)});resetPromotionForm();await loadPromotions()}
  catch(err){$("promoFormError").textContent=err.message}
  finally{button.disabled=false}
}
async function patchPromotion(id,body){try{await api("/api/admin/promotions/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify(body)});await loadPromotions()}catch(e){window.alert(e.message)}}
function togglePromotion(id,active){patchPromotion(id,{active})}
function startPromotionNow(id){if(!window.confirm("Colocar esta promoção no ar agora?"))return;patchPromotion(id,{starts_at:new Date().toISOString()})}
function endPromotionNow(id){if(!window.confirm("Encerrar esta promoção agora? Ela sai do site na hora (pedidos já feitos mantêm o presente)."))return;patchPromotion(id,{ends_at:new Date().toISOString()})}
async function deletePromotion(id){const p=promotions.find(x=>String(x.id)===String(id));if(!window.confirm("Excluir a promoção "+(p?.name||"")+"? Os pedidos que já ganharam o presente continuam com ele. Esta ação não pode ser desfeita."))return;try{await api("/api/admin/promotions/"+encodeURIComponent(id),{method:"DELETE"});if(String($("promoId").value)===String(id))resetPromotionForm();await loadPromotions()}catch(e){window.alert(e.message)}}

registerClickActions({editPromotion,togglePromotion,startPromotionNow,endPromotionNow,deletePromotion,editCoupon,toggleCoupon,deleteCoupon,approveOrder,rejectOrder,markRefundDone,openProduct,toggleProduct,adjustStock,openOrder,closeOrder,sendTrackingWhatsApp,sendTrackingEmail,syncPaidOrderOlist,saveOrderStatus,removeProductImage,removePendingImage});

/* =====================================================
   FOTOS LEVES
   O navegador do painel reduz e converte as fotos dos PRODUTOS para WebP
   antes de enviar: uma versão grande (galeria) e uma pequena (cards,
   miniaturas e sacola). O botão OTIMIZAR FOTOS DO SITE faz o mesmo com as
   fotos de produtos que já estão no site; a lista original de cada produto
   fica guardada no banco (images_original). As fotos do carrossel do topo
   nunca são trocadas: continuam exatamente como foram enviadas. As do banner
   do meio são reduzidas na hora de enviar, com qualidade mais alta.
===================================================== */
const PHOTO_SIZES={product:{full:1600,small:640,quality:[.84,.8]},banner:{full:2400,small:1200,quality:[.9,.86]}};
// Link curto fixo de cada bolsa para mandar à cliente: a prévia (WhatsApp, Instagram) mostra a
// foto e o nome, e a cliente cai na loja com a bolsa aberta. Só o link, em texto: um toque
// seleciona ele inteiro para copiar. Só aparece em bolsa ativa.
function productLinkHtml(p){if(!p.active||!/^[A-Za-z0-9]{6,12}$/.test(String(p.short_code||"")))return "";return `<div class="admin-product-link"><span class="admin-product-link-text">oficialmontee.com.br/?p=${esc(p.short_code)}</span></div>`}
function smallPhoto(url){return isOptimizedPhoto(url)?String(url).replace(/-full\.(webp|jpg)$/,"-small.$1"):url}
function isOptimizedPhoto(url){return /\/opt\/[^?#]+-full\.(webp|jpg)$/.test(String(url||""))}
async function loadImageSource(source){
  if(window.createImageBitmap){try{return await createImageBitmap(source)}catch{}}
  const url=URL.createObjectURL(source);
  try{const img=new Image();img.src=url;await img.decode();return img}finally{setTimeout(()=>URL.revokeObjectURL(url),2000)}
}
function drawScaled(image,maxSide){
  const w=image.naturalWidth||image.width,h=image.naturalHeight||image.height;
  const scale=Math.min(1,maxSide/Math.max(w,h));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
  const ctx=canvas.getContext("2d");ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
  ctx.drawImage(image,0,0,canvas.width,canvas.height);
  return canvas;
}
function canvasBlob(canvas,type,quality){return new Promise(resolve=>canvas.toBlob(resolve,type,quality))}
async function encodeCanvas(canvas,quality){
  const webp=await canvasBlob(canvas,"image/webp",quality);
  if(webp&&webp.type==="image/webp")return webp;
  // Navegador sem WebP: JPEG com fundo branco.
  const flat=document.createElement("canvas");flat.width=canvas.width;flat.height=canvas.height;
  const ctx=flat.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,flat.width,flat.height);ctx.drawImage(canvas,0,0);
  return canvasBlob(flat,"image/jpeg",quality);
}
async function optimizePhoto(source,kind){
  const sizes=PHOTO_SIZES[kind]||PHOTO_SIZES.product;
  const image=await loadImageSource(source);
  const fullCanvas=drawScaled(image,sizes.full),smallCanvas=drawScaled(image,sizes.small);
  if(typeof image.close==="function")image.close();
  const full=await encodeCanvas(fullCanvas,sizes.quality[0]),small=await encodeCanvas(smallCanvas,sizes.quality[1]);
  if(!full||!small||full.type!==small.type)throw new Error("Não foi possível converter a foto.");
  return {contentType:full.type,full,small,width:fullCanvas.width,height:fullCanvas.height};
}
// Envia direto para o Supabase (endereço de envio criado pelo servidor). Se não der,
// manda pelo servidor como antes.
async function putSignedPhoto(uploadUrl,blob){
  const form=new FormData();form.append("cacheControl","31536000");form.append("",blob);
  const r=await fetch(uploadUrl,{method:"PUT",headers:{"x-upsert":"false"},body:form});
  if(!r.ok)throw new Error("Envio da foto falhou ("+r.status+").");
}
async function uploadOptimizedPhoto(source,kind,productId){
  const photo=await optimizePhoto(source,kind);
  try{
    const s=await api("/api/admin/uploads/optimized-image/sign",{method:"POST",body:JSON.stringify({kind,product_id:productId||"",content_type:photo.contentType})});
    await Promise.all([putSignedPhoto(s.full.upload_url,photo.full),putSignedPhoto(s.small.upload_url,photo.small)]);
    return {url:s.full.url,width:photo.width,height:photo.height};
  }catch(e){console.warn("Envio direto falhou; enviando pelo servidor:",e.message)}
  const d=await api("/api/admin/uploads/optimized-image",{method:"POST",body:JSON.stringify({kind,product_id:productId||"",content_type:photo.contentType,full_base64:await readFileAsDataUrl(photo.full),small_base64:await readFileAsDataUrl(photo.small)})});
  return {url:d.url,width:d.width||photo.width,height:d.height||photo.height};
}
async function fetchPhotoBlob(url){const r=await fetch(url,{cache:"no-store",mode:"cors"});if(!r.ok)throw new Error("Foto indisponível ("+r.status+").");return r.blob()}

function photosToOptimize(){
  return products.map(p=>({product:p,urls:(Array.isArray(p.images)?p.images:[]).filter(u=>/^https:\/\//.test(String(u||""))&&!isOptimizedPhoto(u))})).filter(x=>x.urls.length);
}
function renderPhotoOptimizerInfo(){
  const box=$("optimizePhotosStatus"),btn=$("optimizePhotosButton");if(!box||!btn||btn.dataset.running)return;
  const pending=photosToOptimize(),count=pending.reduce((n,x)=>n+x.urls.length,0);
  box.textContent=count?`${count} foto${count>1?"s":""} de ${pending.length} produto${pending.length>1?"s":""} ainda estão no tamanho original. Otimizar deixa a loja bem mais rápida no celular; a qualidade na tela continua a mesma.`:"Todas as fotos dos produtos já estão otimizadas. As fotos novas são otimizadas automaticamente ao enviar.";
  btn.hidden=!count;
}
async function optimizeExistingPhotos(){
  const btn=$("optimizePhotosButton"),box=$("optimizePhotosStatus");
  const pending=photosToOptimize(),total=pending.reduce((n,x)=>n+x.urls.length,0);
  if(!total){renderPhotoOptimizerInfo();return}
  if(!window.confirm(`Otimizar ${total} foto${total===1?"":"s"} de produtos?\n\nO painel baixa cada foto, cria uma versão leve (WebP) e troca no site. As originais continuam guardadas. As fotos do banner não são alteradas. Deixe esta aba aberta até terminar (alguns minutos).`))return;
  btn.dataset.running="1";btn.disabled=true;
  let done=0,failed=0,message="";
  const progress=()=>{box.textContent=`Otimizando… ${done+failed} de ${total}${failed?` (${failed} sem sucesso)`:""}. Deixe esta aba aberta.`};
  progress();
  try{
    for(const {product} of pending){
      const images=[...product.images];
      // Três fotos por vez.
      for(let i=0;i<images.length;i+=3){
        await Promise.all(images.slice(i,i+3).map(async(url,k)=>{
          if(!/^https:\/\//.test(String(url||""))||isOptimizedPhoto(url))return;
          try{images[i+k]=(await uploadOptimizedPhoto(await fetchPhotoBlob(url),"product",product.id)).url;done++}
          catch(e){failed++;console.warn("Foto não otimizada:",url,e.message)}
          progress();
        }));
      }
      if(images.some((u,i)=>u!==product.images[i]))await api("/api/admin/products/"+encodeURIComponent(product.id)+"/images",{method:"PUT",body:JSON.stringify({images})});
    }
    message=`Pronto: ${done} foto${done===1?"":"s"} otimizada${done===1?"":"s"}${failed?`, ${failed} não puderam ser otimizadas (ficaram como estavam; clique de novo para tentar só essas)`:""}.`;
  }catch(e){message="A otimização parou: "+e.message+" Clique de novo para continuar de onde parou."}
  finally{
    // Recarrega a lista antes de liberar o botão, para o aviso final não ser trocado.
    await loadProducts().catch(()=>{});
    delete btn.dataset.running;btn.disabled=false;
    box.textContent=message;btn.hidden=!photosToOptimize().length;
  }
}
(function(){const btn=$("optimizePhotosButton");if(btn)btn.onclick=optimizeExistingPhotos})();

/* =====================================================
   ORGANIZAÇÃO DO PAINEL
   Abas dentro das seções (Promoções e Estoque), formulários de cupom e
   promoção que abrem só quando precisa, e o quadro "Precisa da sua
   atenção" da visão geral (com o contador de pedidos no menu).
===================================================== */
function showSubtab(section,name){
  const sec=$(section+"Section");if(!sec)return;
  sec.querySelectorAll(".subtab").forEach(b=>{const on=b.dataset.subtab===name;b.classList.toggle("active",on);b.setAttribute("aria-selected",on?"true":"false")});
  sec.querySelectorAll("[data-subpanel]").forEach(p=>{p.hidden=p.dataset.subpanel!==name});
}
document.querySelectorAll(".subtab").forEach(b=>b.addEventListener("click",()=>showSubtab(b.closest(".section").id.replace(/Section$/,""),b.dataset.subtab)));
function openDrawer(id,focusId){const d=$(id);if(!d)return;d.open=true;if(focusId)setTimeout(()=>{const el=$(focusId);if(el)el.focus({preventScroll:true})},0)}
function closeDrawer(id){const d=$(id);if(d)d.open=false}
// Fechar o formulário no meio de uma edição cancela a edição.
[["couponFormPanel","couponId",()=>resetCouponForm()],["promoFormPanel","promoId",()=>resetPromotionForm()]].forEach(([panel,idField,reset])=>{const d=$(panel);if(d)d.addEventListener("toggle",()=>{if(!d.open&&$(idField).value)reset()})});
(function(){
  const newCoupon=$("newCouponButton");
  if(newCoupon)newCoupon.onclick=()=>{resetCouponForm();openDrawer("couponFormPanel","couponCodeInput");$("couponFormPanel").scrollIntoView({behavior:"smooth",block:"start"})};
  const newPromo=$("newPromoButton");
  if(newPromo)newPromo.onclick=()=>{resetPromotionForm();showSubtab("promotions","gifts");openDrawer("promoFormPanel","promoName");$("promoFormPanel").scrollIntoView({behavior:"smooth",block:"start"})};
})();
function goTo(section,subtab){showSection(section);if(subtab)showSubtab(section,subtab)}
registerClickActions({goTo,setOrderTest});

/* =====================================================
   VISÃO GERAL — DASHBOARD
   Vendas do site: pedidos pagos, em separação, enviados ou entregues, sem os
   pedidos de teste (is_test); a data é a do pagamento (ou a do pedido).
   Vendas de fora do site: os pedidos da Olist que o site não criou
   (/api/admin/olist/sales), nas situações que contam como venda.
   "Vendas de" (Site, Fora do site, Site + Olist) vale para o topo, os números,
   o gráfico e as listas; o período (de uma data a outra; começa no dia 1º do mês até
   hoje) vale para a parte "Vendas". Expedição e últimos pedidos são sempre os pedidos do site.
===================================================== */
const SALE_STATUSES=["paid","processing","shipped","delivered"];
const DAY_MS=86400000;
const DASH_SOURCES={site:"Site",olist:"Fora do site (Olist)",all:"Site + Olist"};
let dashFrom="",dashTo="",dashSource="all";
let olistSales=[],olistSaleSituations=[1,3,4,5,6,7],olistSalesStatus=null,olistSalesEnabled=true,olistSalesError="",olistSalesLoaded=false;
try{const src=localStorage.getItem("monteDashSource");if(DASH_SOURCES[src])dashSource=src}catch{}
function isTestOrder(o){return o&&o.is_test===true}
function realOrders(){return orders.filter(o=>!isTestOrder(o))}
function saleTime(o){return new Date(o.paid_at||o.created_at).getTime()}
function realSales(){return realOrders().filter(o=>SALE_STATUSES.includes(o.status))}
function soldItems(o){const list=Array.isArray(o.order_items)&&o.order_items.length?o.order_items:(Array.isArray(o.items)?o.items:[]);return list.filter(i=>Number(i.total_price??(Number(i.unit_price||i.price||0)*Number(i.quantity||1)))>0)}
function startOfDay(t){const d=new Date(t);d.setHours(0,0,0,0);return d.getTime()}
function plural(n,one,many){return n===1?one:many}
function paymentLabel(v){const s=String(v||"").trim(),t=s.toLowerCase();if(!t)return "Não informado";if(t.includes("pix"))return "Pix";const cred=t.includes("créd")||t.includes("cred"),deb=t.includes("déb")||t.includes("deb");if(cred&&deb)return "Cartão (crédito ou débito)";if(t==="credit_card"||cred)return "Cartão de crédito";if(t==="debit_card"||t.includes("déb")||t.includes("deb"))return "Cartão de débito";if(t.includes("dinheiro"))return "Dinheiro";if(t.includes("boleto"))return "Boleto";if(t.includes("transfer"))return "Transferência";return s.charAt(0).toUpperCase()+s.slice(1)}
function olistChannel(s){if(Number(s.origem)===1)return "Olist · loja (PDV)";if(s.canal)return "Olist · "+s.canal;return "Olist · pedido de venda"}
// Venda no mesmo formato para o site e a Olist: data, valor, itens, pagamento, envio e canal.
function siteSaleRows(){return realSales().map(o=>({source:"site",time:saleTime(o),total:Number(o.total||0),hasItems:true,items:soldItems(o).map(i=>({key:String(i.product_id||i.product_name||"—"),product_id:i.product_id,name:i.product_name||"Produto",qty:Number(i.quantity||1),total:Number(i.total_price??(Number(i.unit_price||0)*Number(i.quantity||1)))})),payment:paymentLabel(o.payment_method),shipping:shippingMethod(o),channel:"Site",pay:o.infinitepay||null,order:o}))}
function productsBySku(){const map=new Map();products.forEach(p=>{if(p.sku)map.set(String(p.sku).toUpperCase(),p);(p.product_variants||[]).forEach(v=>{if(v.sku)map.set(String(v.sku).toUpperCase(),p)})});return map}
function olistSaleRows(){
  const ok=new Set(olistSaleSituations.map(Number)),bySku=productsBySku();
  return olistSales.filter(s=>ok.has(Number(s.situacao))&&s.data).map(s=>({source:"olist",time:new Date(String(s.data).slice(0,10)+"T12:00:00").getTime(),total:Number(s.total||0),hasItems:!!s.detail_at,
    items:(Array.isArray(s.itens)?s.itens:[]).filter(i=>Number(i.valor)>0).map(i=>{const p=i.sku?bySku.get(String(i.sku).toUpperCase()):null;return {key:p?String(p.id):"olist:"+(i.sku||i.descricao),product_id:p?p.id:null,name:p?p.name:(i.descricao||"Produto"),qty:Number(i.quantidade||1),total:Number(i.valor||0)*Number(i.quantidade||1)}}),
    payment:s.detail_at?paymentLabel(s.pagamento):"Não informado",shipping:s.envio||(Number(s.origem)===1?"Na loja (PDV)":"Não informado na Olist"),channel:olistChannel(s),pay:s.infinitepay||null,olist:s}));
}
function dashRows(){return dashSource==="site"?siteSaleRows():dashSource==="olist"?olistSaleRows():siteSaleRows().concat(olistSaleRows())}
function dashSales(){return dashRows()}
// Líquido de um período: nos dias que o relatório da InfinitePay cobre, o do relatório (igual
// ao da conta); no resto, o calculado pelas taxas (exato no site, estimado na loja).
function periodNet(start,end){
  const txs=ipTxIn(start,end,dashSource);
  const calc=dashRows().filter(s=>s.time>=start&&s.time<=end&&!ipCovered(s.time,s.source==="site"));
  const cents=txs.reduce((n,t)=>n+Math.round(t.liquido*100),0)+calc.reduce((n,s)=>n+Math.round((s.pay?Number(s.pay.net):Number(s.total||0))*100),0);
  return {net:cents/100,approx:calc.some(s=>s.pay&&s.pay.estimated&&s.pay.fee>0),txs,calc};
}
function sumTotal(list){return list.reduce((n,s)=>n+Number(s.total||0),0)}
function soldPieces(list){return list.reduce((n,s)=>n+s.items.reduce((m,i)=>m+i.qty,0),0)}
// Variação em relação ao mesmo período do mês anterior: seta + número + com o quê comparou (a cor nunca vai sozinha).
// A cor: classe "up" é verde e "down" é vermelho. neutral: sem verde nem vermelho (juros).
// inverse: menor é melhor (porcentagem das taxas): caiu fica verde e subiu fica vermelho; a seta continua mostrando se subiu ou caiu.
function trendTone(dir,{neutral=false,inverse=false}={}){return dir==="flat"?"flat":neutral?"neutral":inverse?(dir==="up"?"down":"up"):dir}
function deltaHtml(cur,prev,label,{neutral=false,empty="sem vendas"}={}){
  if(!prev&&!cur)return `<span class="delta-label">${esc(label)}: ${esc(empty)}</span>`;
  if(!prev)return `<span class="delta-value ${trendTone("up",{neutral})}">▲ novo</span> <span class="delta-label">${esc(label)}: ${esc(empty)}</span>`;
  const dir=window.DashCompare.trend(cur,prev),abs=Math.abs((cur-prev)/prev*100);
  const text=dir==="flat"?"= igual":(dir==="up"?"▲ ":"▼ ")+(abs>=999?"999+":abs<0.1?"menos de 0,1":abs.toLocaleString("pt-BR",{maximumFractionDigits:abs<10?1:0}))+"%";
  return `<span class="delta-value ${trendTone(dir,{neutral})}">${text}</span> <span class="delta-label">${esc(label)}</span>`;
}
// O número em verde quando subiu, em vermelho quando caiu e na cor normal quando ficou igual.
function setTrend(el,cur,prev){if(!el)return;const dir=window.DashCompare.trend(cur,prev);["up","down","flat"].forEach(c=>el.classList.toggle(c,c===dir))}
function renderDashboard(){
  const sales=dashSales();
  renderDashboardSource();
  renderDashboardHero(sales);
  renderDashboardTodo();
  renderDashboardPeriod(sales);
  renderDashboardPipeline();
  setHTML($("recentOrders"), orderTable(realOrders().filter(o=>o.status!=="expired").slice(0,6)));
}
// "Vendas de" e a situação da leitura da Olist.
function renderDashboardSource(){
  document.querySelectorAll(".dash-src").forEach(b=>{const on=b.dataset.source===dashSource;b.classList.toggle("active",on);b.setAttribute("aria-pressed",on?"true":"false")});
  const box=$("olistSalesStatus");if(!box)return;
  const st=olistSalesStatus||{},count=olistSaleRows().length,button=$("olistSalesSync");
  let text;
  if(!olistSalesEnabled)text="A integração com a Olist está desligada neste servidor.";
  else if(olistSalesError)text="Olist: "+olistSalesError;
  else if(!olistSalesLoaded)text="Carregando as vendas da Olist…";
  else if(st.last_error&&st.rate_limited)text=`Importando as vendas da Olist… ${count} ${plural(count,"venda","vendas")} de fora do site até agora. A Olist pediu uma pausa nas consultas; a importação continua sozinha em alguns minutos.`;
  else if(st.last_error)text="Olist: "+st.last_error;
  else if(!st.last_run_at)text="As vendas da Olist ainda não foram lidas. Clique em ATUALIZAR DA OLIST.";
  else if(st.reading||st.pending_details)text=`Importando as vendas da Olist… ${count} ${plural(count,"venda","vendas")} de fora do site até agora.`;
  else text=`${count} ${plural(count,"venda","vendas")} de fora do site · Olist lida às ${new Date(st.last_run_at).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})} de ${new Date(st.last_run_at).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})}`;
  box.textContent=text;
  box.classList.toggle("is-error",!!(olistSalesError||(st.last_error&&!st.rate_limited)));
  if(button)button.hidden=!olistSalesEnabled;
}
function renderDashboardHero(sales){
  const now=new Date(),day=now.getDate();
  const first=new Date(now.getFullYear(),now.getMonth(),1),start=first.getTime();
  const p=window.DashCompare.previousMonthRange(first,new Date(now.getFullYear(),now.getMonth(),day),now);
  const cur=sales.filter(s=>s.time>=start),prev=sales.filter(s=>s.time>=p.start&&s.time<p.end);
  const month=now.toLocaleDateString("pt-BR",{month:"long"}),prevMonth=p.from.toLocaleDateString("pt-BR",{month:"long"}),prevDay=p.to.getDate();
  if($("heroLabel"))$("heroLabel").textContent="FATURAMENTO DE "+month.toUpperCase()+" · "+DASH_SOURCES[dashSource].toUpperCase();
  if(!$("statRevenue"))return;
  const total=sumTotal(cur),prevTotal=sumTotal(prev);
  $("statRevenue").textContent=money(total);
  setTrend($("statRevenue"),total,prevTotal);
  setHTML($("heroDelta"), deltaHtml(total,prevTotal,`vs ${prevDay===1?"1º":"1º a "+prevDay} de ${prevMonth}`));
  // O líquido conta as mesmas vendas do faturamento: as da Olist só têm o dia (ficam ao meio-dia),
  // então a venda de hoje lançada na Olist entra mesmo antes do meio-dia.
  if($("heroNet")){const n=periodNet(start,new Date(now.getFullYear(),now.getMonth(),day+1).getTime()-1);$("heroNet").textContent=cur.length||n.txs.length?`Líquido na InfinitePay: ${(n.approx?"≈ ":"")+money(n.net)}`:""}
  $("statRevenueHint").textContent=cur.length?`${cur.length} ${plural(cur.length,"venda","vendas")} · ticket médio ${money(total/cur.length)}`:"Nenhuma venda este mês ainda";
}
// Datas no formato dos campos (AAAA-MM-DD), no fuso do navegador.
function ymd(t){const d=new Date(t);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function fromYmd(v){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v||""));return m?new Date(Number(m[1]),Number(m[2])-1,Number(m[3])):null}
function brDate(t){return new Date(t).toLocaleDateString("pt-BR")}
// Na comparação, sem o ano quando é o ano atual (cabe numa linha no celular).
function brShort(t){const d=new Date(t);return d.getFullYear()===new Date().getFullYear()?d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"}):brDate(t)}
// Período escolhido: de uma data a outra (as duas inclusas; padrão: dia 1º do mês até hoje).
// A comparação é com o mesmo período do mês anterior (dash-compare.js).
function dashRange(){
  const now=new Date(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  let from=fromYmd(dashFrom)||new Date(today.getFullYear(),today.getMonth(),1),to=fromYmd(dashTo)||today;
  if(to>today)to=today;
  if(from>to)[from,to]=[to,from];
  const days=Math.round((to-from)/DAY_MS)+1;
  const p=window.DashCompare.previousMonthRange(from,to,now);
  const prevLabel=p.from.getTime()===p.to.getTime()?brShort(p.from):`${brShort(p.from)} a ${brShort(p.to)}`;
  const end=new Date(to.getFullYear(),to.getMonth(),to.getDate()+1).getTime()-1;
  return{start:from.getTime(),end,prevStart:p.start,prevEnd:p.end,prev:{start:p.start,end:p.end-1},days,from:ymd(from),to:ymd(to),max:ymd(today),
    label:days===1?"em "+brDate(from):`de ${brDate(from)} a ${brDate(to)}`,prevLabel,compare:"vs "+prevLabel};
}
function renderDashboardPeriod(sales){
  const r=dashRange(),inRange=(s,a,b)=>s.time>=a&&s.time<=b;
  const fromInput=$("dashFrom"),toInput=$("dashTo");
  if(fromInput){fromInput.value=r.from;fromInput.max=r.max}
  if(toInput){toInput.value=r.to;toInput.max=r.max}
  const cur=sales.filter(s=>inRange(s,r.start,r.end)),prev=sales.filter(s=>s.time>=r.prevStart&&s.time<r.prevEnd);
  const revenue=sumTotal(cur),pieces=soldPieces(cur),noItems=cur.filter(s=>!s.hasItems).length;
  // Valor em verde quando subiu em relação ao mesmo período do mês anterior, em vermelho quando caiu, preto quando igual.
  const kpi=(label,value,c,p,sub,extra="")=>`<div class="kpi"><span class="kpi-label">${esc(label)}</span><strong class="kpi-value ${window.DashCompare.trend(c,p)}">${esc(value)}</strong>${extra}<span class="delta">${deltaHtml(c,p,r.compare)}</span><small class="kpi-sub">${esc(sub)}</small></div>`;
  const prevRevenue=sumTotal(prev),prevTicket=prev.length?prevRevenue/prev.length:0;
  setHTML($("dashKpis"),
    kpi("Faturamento",money(revenue),revenue,prevRevenue,dashSource==="olist"?"valor dos pedidos na Olist":"total pago pelas clientes, com frete",(()=>{const n=periodNet(r.start,r.end);return cur.length||n.txs.length?`<span class="kpi-net">líquido ${esc((n.approx?"≈ ":"")+money(n.net))}</span>`:""})())+
    kpi("Vendas",fmtInt(cur.length),cur.length,prev.length,dashSource==="site"?"pedidos pagos":"pedidos pagos no site e vendas na Olist")+
    kpi("Ticket médio",money(cur.length?revenue/cur.length:0),cur.length?revenue/cur.length:0,prevTicket,"valor médio por venda")+
    kpi("Peças vendidas",fmtInt(pieces),pieces,soldPieces(prev),noItems?`${noItems} ${plural(noItems,"venda da Olist ainda sem itens","vendas da Olist ainda sem itens")}`:"sem contar os presentes"));
  renderRevenueChart(revenueBins(cur,r));
  renderTopProducts(cur);
  renderRankList($("dashPayments"),groupSales(cur,s=>s.payment),"revenue");
  renderRankList($("dashShippingMethods"),groupSales(cur,s=>s.shipping),"count");
  const channels=$("dashChannelsPanel");
  if(channels){channels.hidden=dashSource==="site";if(dashSource!=="site")renderRankList($("dashChannels"),groupSales(cur,s=>s.channel),"revenue")}
  renderDashboardNet(r);
}
// Um ponto por dia; períodos longos (mais de 92 dias) viram semanas.
function revenueBins(list,r){
  const days=Math.max(1,Math.round((startOfDay(r.end)-r.start)/DAY_MS)+1),step=days>92?7:1,bins=[];
  for(let t=r.start;t<=r.end;t+=step*DAY_MS)bins.push({start:t,end:t+step*DAY_MS,revenue:0,count:0,site:0,olist:0,week:step>1});
  list.forEach(s=>{const b=bins.find(x=>s.time>=x.start&&s.time<x.end);if(b){b.revenue+=s.total;b.count++;b[s.source]+=s.total}});
  return bins;
}
function shortDate(t){return new Date(t).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})}
function binLabel(b){return b.week?"semana de "+shortDate(b.start):new Date(b.start).toLocaleDateString("pt-BR",{weekday:"short",day:"2-digit",month:"2-digit"})}
function niceStep(max,ticks){const raw=max/ticks,mag=Math.pow(10,Math.floor(Math.log10(raw||1))),n=raw/mag;return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*mag}
function axisMoney(v){return v>=10000?(v/1000).toLocaleString("pt-BR",{maximumFractionDigits:1})+" mil":v.toLocaleString("pt-BR",{maximumFractionDigits:0})}
function renderRevenueChart(bins){
  const box=$("dashRevenueChart");if(!box)return;
  box._bins=bins;
  const total=bins.reduce((n,b)=>n+b.revenue,0),count=bins.reduce((n,b)=>n+b.count,0),withSales=bins.filter(b=>b.count),both=dashSource==="all";
  if($("dashChartHint"))$("dashChartHint").textContent=count?`${money(total)} em ${count} ${plural(count,"venda","vendas")} no período (${DASH_SOURCES[dashSource].toLowerCase()}). ${window.matchMedia&&window.matchMedia("(hover: none)").matches?"Toque em uma coluna":"Passe o mouse ou use as setas do teclado"} para ver cada ${bins[0]&&bins[0].week?"semana":"dia"}.`:"Nenhuma venda no período.";
  box.setAttribute("aria-label","Gráfico de colunas do faturamento por "+(bins[0]&&bins[0].week?"semana":"dia")+": "+money(total)+" no período.");
  const W=Math.round(box.clientWidth);
  if(!W){box._pending=true;return}
  box._pending=false;box._width=W;
  const H=W<520?220:260,padL=W<520?40:52,padR=10,padT=26,padB=28,plotW=W-padL-padR,plotH=H-padT-padB,base=padT+plotH;
  const max=Math.max(0,...bins.map(b=>b.revenue)),step=niceStep(max||1000,4),top=Math.max(step,Math.ceil((max||1)/step)*step);
  const y=v=>base-(v/top)*plotH,slot=plotW/bins.length,barW=Math.max(2,Math.min(24,slot*0.62));
  let grid="";for(let v=0;v<=top+0.001;v+=step){const gy=y(v).toFixed(1);grid+=`<line x1="${padL}" x2="${W-padR}" y1="${gy}" y2="${gy}" class="dc-grid${v===0?" dc-base":""}"/><text x="${padL-8}" y="${(+gy+4).toFixed(1)}" text-anchor="end" class="dc-tick">${axisMoney(v)}</text>`}
  const labelEvery=Math.max(1,Math.ceil(bins.length/(W<520?4:8)));
  let bars="",labels="",maxIdx=-1;
  bins.forEach((b,i)=>{
    const cx=padL+slot*i+slot/2,x=cx-barW/2;
    if(b.revenue>0){const yy=y(b.revenue),h=base-yy,rr=Math.min(4,barW/2,h);bars+=`<path class="dc-bar" data-i="${i}" d="M${x.toFixed(1)} ${base} V${(yy+rr).toFixed(1)} Q${x.toFixed(1)} ${yy.toFixed(1)} ${(x+rr).toFixed(1)} ${yy.toFixed(1)} H${(x+barW-rr).toFixed(1)} Q${(x+barW).toFixed(1)} ${yy.toFixed(1)} ${(x+barW).toFixed(1)} ${(yy+rr).toFixed(1)} V${base} Z"/>`;if(maxIdx<0||b.revenue>bins[maxIdx].revenue)maxIdx=i}
    if((bins.length-1-i)%labelEvery===0)labels+=`<text x="${cx.toFixed(1)}" y="${H-8}" text-anchor="middle" class="dc-tick">${esc(shortDate(b.start))}</text>`;
  });
  let peak="";
  if(maxIdx>=0){const cx=padL+slot*maxIdx+slot/2,tx=Math.min(W-padR-4,Math.max(padL+4,cx)),anchor=tx===cx?"middle":(tx<cx?"end":"start");peak=`<text x="${tx.toFixed(1)}" y="${(y(bins[maxIdx].revenue)-8).toFixed(1)}" text-anchor="${anchor}" class="dc-peak">${esc(money(bins[maxIdx].revenue))}</text>`}
  setHTML(box,`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><g>${grid}</g><line class="dc-cross" x1="0" x2="0" y1="${padT}" y2="${base}" visibility="hidden"/><g>${bars}</g>${peak}<g>${labels}</g></svg><div class="dc-tip" hidden><span class="dc-tip-date"></span><strong class="dc-tip-value"></strong><span class="dc-tip-count"></span><span class="dc-tip-split" hidden></span></div>`);
  box._geo={padL,slot,padT,base,W};
  // Tabela: o mesmo conteúdo do gráfico, sem precisar passar o mouse.
  const unit=bins[0]&&bins[0].week?"SEMANA":"DIA";
  setHTML($("dashRevenueTable"),withSales.length?`<table class="table"><thead><tr><th>${unit}</th><th>VENDAS</th>${both?"<th>SITE</th><th>OLIST</th>":""}<th>FATURAMENTO</th></tr></thead><tbody>${withSales.slice().reverse().map(b=>`<tr><td>${esc(binLabel(b))}</td><td>${fmtInt(b.count)}</td>${both?`<td>${money(b.site)}</td><td>${money(b.olist)}</td>`:""}<td>${money(b.revenue)}</td></tr>`).join("")}<tr class="dc-total"><td>Total</td><td>${fmtInt(count)}</td>${both?`<td>${money(bins.reduce((n,b)=>n+b.site,0))}</td><td>${money(bins.reduce((n,b)=>n+b.olist,0))}</td>`:""}<td>${money(total)}</td></tr></tbody></table>`:'<p class="field-help">Nenhuma venda no período.</p>');
  if(box._active!=null)showChartTip(box,Math.min(box._active,bins.length-1));
}
function showChartTip(box,i){
  const bins=box._bins,g=box._geo;if(!bins||!g||i<0||i>=bins.length)return;
  box._active=i;const b=bins[i],tip=box.querySelector(".dc-tip"),cross=box.querySelector(".dc-cross");
  box.querySelectorAll(".dc-bar").forEach(el=>el.classList.toggle("is-active",Number(el.dataset.i)===i));
  const cx=g.padL+g.slot*i+g.slot/2;
  if(cross){cross.setAttribute("x1",cx);cross.setAttribute("x2",cx);cross.setAttribute("visibility","visible")}
  tip.querySelector(".dc-tip-date").textContent=binLabel(b);
  tip.querySelector(".dc-tip-value").textContent=money(b.revenue);
  tip.querySelector(".dc-tip-count").textContent=b.count?`${b.count} ${plural(b.count,"venda","vendas")}`:"sem vendas";
  const split=tip.querySelector(".dc-tip-split");split.hidden=!(dashSource==="all"&&b.count);split.textContent=`Site ${money(b.site)} · Olist ${money(b.olist)}`;
  tip.hidden=false;
  const w=tip.offsetWidth,left=cx+14+w<=g.W?cx+14:Math.max(0,cx-14-w);
  tip.style.left=left+"px";tip.style.top=Math.max(0,g.padT-6)+"px";
}
function hideChartTip(box){box._active=null;const tip=box.querySelector(".dc-tip"),cross=box.querySelector(".dc-cross");if(tip)tip.hidden=true;if(cross)cross.setAttribute("visibility","hidden");box.querySelectorAll(".dc-bar.is-active").forEach(el=>el.classList.remove("is-active"))}
(function(){
  const box=$("dashRevenueChart");if(!box)return;
  const indexAt=e=>{const g=box._geo;if(!g)return -1;const x=e.clientX-box.getBoundingClientRect().left;return Math.max(0,Math.min(box._bins.length-1,Math.floor((x-g.padL)/g.slot)))};
  box.addEventListener("pointermove",e=>{const i=indexAt(e);if(i>=0)showChartTip(box,i)});
  box.addEventListener("pointerdown",e=>{const i=indexAt(e);if(i>=0)showChartTip(box,i)});
  // No toque a dica fica até tocar fora do gráfico; com o mouse some ao sair.
  box.addEventListener("pointerleave",e=>{if(e.pointerType!=="touch"&&document.activeElement!==box)hideChartTip(box)});
  document.addEventListener("pointerdown",e=>{if(box._active!=null&&!box.contains(e.target))hideChartTip(box)});
  box.addEventListener("focus",()=>{const bins=box._bins||[];let i=bins.length-1;for(let k=bins.length-1;k>=0;k--)if(bins[k].count){i=k;break}showChartTip(box,i)});
  box.addEventListener("blur",()=>hideChartTip(box));
  box.addEventListener("keydown",e=>{const bins=box._bins||[];if(!bins.length)return;let i=box._active??bins.length-1;if(e.key==="ArrowLeft")i--;else if(e.key==="ArrowRight")i++;else if(e.key==="Home")i=0;else if(e.key==="End")i=bins.length-1;else if(e.key==="Escape"){hideChartTip(box);return}else return;e.preventDefault();showChartTip(box,Math.max(0,Math.min(bins.length-1,i)))});
  // O gráfico acompanha a largura da tela (e aparece certo quando a Visão geral volta a ser mostrada).
  if(window.ResizeObserver){let frame=0;new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const w=Math.round(box.clientWidth);if(w&&(box._pending||w!==box._width)&&box._bins)renderRevenueChart(box._bins)})}).observe(box)}
  // De / até: ao trocar uma data, a parte "Vendas" é refeita (datas trocadas são acertadas).
  const pickDates=()=>{dashFrom=$("dashFrom").value||"";dashTo=$("dashTo").value||"";renderDashboardPeriod(dashSales())};
  ["dashFrom","dashTo"].forEach(id=>{const el=$(id);if(el)el.addEventListener("change",pickDates)});
  document.querySelectorAll(".dash-src").forEach(b=>b.addEventListener("click",()=>{dashSource=DASH_SOURCES[b.dataset.source]?b.dataset.source:"all";try{localStorage.setItem("monteDashSource",dashSource)}catch{}renderDashboard()}));
  const sync=$("olistSalesSync");if(sync)sync.onclick=syncOlistSalesNow;
  // De volta ao painel (ex.: depois de lançar a venda na Olist): lê a Olist de novo.
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&olistSalesEnabled&&!$("appView").classList.contains("hidden")&&Date.now()-olistSalesReadAt>2*60*1000)syncOlistSalesNow()});
})();
async function loadOlistSales(){
  try{const d=await api("/api/admin/olist/sales");olistSales=Array.isArray(d.sales)?d.sales:[];if(Array.isArray(d.sale_situations)&&d.sale_situations.length)olistSaleSituations=d.sale_situations;olistSalesStatus=d.status||null;olistSalesEnabled=d.enabled!==false;machineFees=d.machine_fees||null;olistSalesError=""}
  catch(e){olistSalesError=e.message}
  olistSalesLoaded=true;renderDashboard();
}
// Lê a Olist agora: o servidor lê um lote por chamada; o painel chama até terminar.
// A primeira chamada relê a lista de pedidos na hora (fresh), para a venda lançada há pouco aparecer.
let olistSalesReadAt=0;
async function syncOlistSalesNow(){
  const button=$("olistSalesSync"),box=$("olistSalesStatus");if(!button||button.disabled)return;
  olistSalesReadAt=Date.now();
  button.disabled=true;button.textContent="LENDO A OLIST...";
  try{
    for(let step=0;step<40;step++){
      const d=await api("/api/admin/olist/sales/sync",{method:"POST",body:JSON.stringify(step===0?{fresh:true}:{})});
      if(d.status)olistSalesStatus=d.status;
      if(d.done)break;
      if(box)box.textContent=d.wait?`A Olist pediu para esperar um pouco. Continuando em ${d.wait} s…`:`Importando as vendas da Olist… ${step+1}º lote lido.`;
      await sleep(d.wait?d.wait*1000:400);
    }
  }catch(e){olistSalesError=e.message}
  finally{button.disabled=false;button.textContent="ATUALIZAR DA OLIST";await loadOlistSales()}
}
/* =====================================================
   VALOR LÍQUIDO DO SITE NA INFINITEPAY
   O servidor manda em cada pedido pago o "infinitepay" (backend/infinitepay-fees.js):
   valor da venda, o que a cliente pagou (com os juros do parcelamento, se houver),
   a taxa da InfinitePay e o líquido. Vale para o período escolhido em "Vendas".
   Os pedidos de teste também passaram pela InfinitePay: ficam fora da conta, mas
   aparecem numa linha à parte para a conta bater com o app.
===================================================== */
let infinitePayFees=null,machineFees=null;
function feePct(v){return Number(v||0).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})+"%"}
function netPayLabel(n){return n.method==="pix"?"Pix":n.installments>1?`Crédito ${n.installments}x`:"Crédito à vista"}
function netFeeLabel(n){return n.fee_percent?`${feePct(n.fee_percent)} · ${netPayLabel(n)}`:`grátis · ${netPayLabel(n)}`}
// Pix não tem juros nem taxa: o que a cliente pagou a mais ou a menos que o pedido no Pix é o
// arredondamento do desconto do Pix na InfinitePay (backend/pix-discount.js).
function pixRoundingSigned(v){v=Number(v||0);return (v>0?"+":"−")+money(Math.abs(v))}
function paidSub(n){
  if(n.interest>0)return `<small class="net-sub">+${money(n.interest)} de juros</small>`;
  return n.pix_rounding?`<small class="net-sub">${pixRoundingSigned(n.pix_rounding)} do arredondamento do Pix</small>`:"";
}
function netLines(o){
  const n=o&&o.infinitepay;if(!n)return "";
  const paidNote=n.interest>0?` (${money(n.interest)} de juros do parcelamento)`
    :n.pix_rounding?` (${money(Math.abs(n.pix_rounding))} a ${n.pix_rounding>0?"mais":"menos"} que o total do pedido: arredondamento do desconto do Pix na InfinitePay)`:"";
  return `<p>Pago pela cliente: <strong>${money(n.paid)}</strong>${paidNote}</p><p>Taxa da InfinitePay (${esc(netFeeLabel(n))}): ${n.fee?"−"+money(n.fee):"sem taxa"}</p><p>Líquido na InfinitePay: <strong>${money(n.net)}</strong></p>`;
}
function sumNet(rows,key){return Math.round(rows.reduce((n,o)=>n+Math.round(Number(o.infinitepay[key]||0)*100),0))/100}
function sumPay(rows,key){return Math.round(rows.reduce((n,s)=>n+Math.round(Number(s.pay[key]||0)*100),0))/100}
function orderCodeLabel(o){return o.order_code?"MONTÊ-"+o.order_code:(o.order_nsu||"—")}
function lowerFirst(t){t=String(t||"");return t.charAt(0).toLowerCase()+t.slice(1)}
function monthLabel(ym){const [y,m]=String(ym).split("-").map(Number);return y&&m?new Date(y,m-1,1).toLocaleDateString("pt-BR",{month:"short",year:"numeric"}).replace(". de "," ").replace(" de "," "):ym}
// Totais do quadro do líquido num período (start e end inclusos): nos dias que o relatório da
// InfinitePay cobre, os valores dele; no resto, o calculado pelas taxas. Serve para o período
// escolhido e para o mesmo período do mês anterior, com as mesmas contas.
function netTotals(range){
  const inRange=t=>t>=range.start&&t<=range.end,cents=v=>Math.round(Number(v||0)*100),sum=(list,f)=>list.reduce((n,x)=>n+cents(f(x)),0);
  const rows=dashRows().filter(s=>inRange(s.time)),pay=rows.filter(s=>s.pay);
  const txs=ipTxIn(range.start,range.end,dashSource),calc=pay.filter(s=>!ipCovered(s.time,s.source==="site"));
  return{rows,pay,txs,calc,sold:sumTotal(rows),sale:sumPay(pay,"sale"),interest:sumPay(pay,"interest"),
    charged:(sum(txs,t=>t.valor)+sum(calc,s=>s.pay.paid))/100,fee:(sum(txs,t=>t.taxa)+sum(calc,s=>s.pay.fee))/100,net:(sum(txs,t=>t.liquido)+sum(calc,s=>s.pay.net))/100};
}
// Um número do quadro do líquido com a comparação com o mesmo período do mês anterior:
// verde quando subiu, vermelho quando caiu, preto quando igual. Juros ficam neutros.
function netStep(r,label,value,sub,cur,prev,{neutral=false,empty="sem vendas",cls=""}={}){
  const tone=neutral?"":trendTone(window.DashCompare.trend(cur,prev));
  return `<div class="net-step${cls}"><span class="net-step-label">${esc(label)}</span><strong${tone?` class="${tone}"`:""}>${esc(value)}</strong><span class="delta">${deltaHtml(cur,prev,r.compare,{neutral,empty})}</span><small>${esc(sub)}</small></div>`;
}
// Taxas: compara a porcentagem (taxas ÷ valor cobrado), não o valor em reais, que sobe junto com as
// vendas. Porcentagem menor que no mesmo período do mês anterior fica verde; maior, vermelha; igual, preta.
// basis: "do cobrado" ou "do valor pago"; approx: a taxa tem parte estimada (≈); extra: o resto da explicação.
function feeStep(r,value,T,P,{basis,approx="",extra=""}){
  const rate=T.charged?Math.round(T.fee/T.charged*10000)/100:null,prev=P.charged?Math.round(P.fee/P.charged*10000)/100:null;
  let tone="",delta;
  if(rate===null)delta=`<span class="delta-label">${prev===null?esc(r.compare)+": sem vendas":`era ${esc(feePct(prev))} ${esc(basis)} em ${esc(r.prevLabel)}`}</span>`;
  else if(prev===null)delta=`<span class="delta-value neutral">${esc(approx+feePct(rate))} ${esc(basis)}</span> <span class="delta-label">${esc(r.compare)}: sem vendas</span>`;
  else{
    const dir=window.DashCompare.trend(rate,prev);tone=trendTone(dir,{inverse:true});
    delta=`<span class="delta-value ${tone}">${dir==="up"?"▲":dir==="down"?"▼":"="} ${esc(approx+feePct(rate))} ${esc(basis)}</span> <span class="delta-label">${dir==="flat"?"igual ao de":"era "+esc(feePct(prev))+" em"} ${esc(r.prevLabel)}</span>`;
  }
  return `<div class="net-step"><span class="net-step-label">− Taxas da InfinitePay</span><strong${tone?` class="${tone}"`:""}>${esc(value)}</strong><span class="delta">${delta}</span>${extra?`<small>${esc(extra)}</small>`:""}</div>`;
}
// Valor líquido de cada venda no período, calculado pelas taxas: site (exato, pelas taxas do
// link de pagamento) e loja (estimado), conforme "Vendas de". Vale quando o período não tem
// relatório da InfinitePay.
function renderDashboardNetCalc(r){
  const inRange=t=>t>=r.start&&t<=r.end;
  const T=netTotals(r),P=netTotals(r.prev);
  const rows=T.pay.slice().sort((a,b)=>b.time-a.time);
  const sale=T.sale,paid=T.charged,interest=T.interest,fee=T.fee,net=T.net;
  const est=rows.filter(s=>s.pay.estimated),estFee=sumPay(est,"fee");
  const withInterest=rows.filter(s=>s.pay.interest>0).length,pix=rows.filter(s=>s.pay.method==="pix").length;
  const pixRounding=sumPay(rows,"pix_rounding");
  const period=r.label;
  const who={site:"Vendas do site",olist:"Vendas da loja (Olist)",all:"Vendas do site e da loja"}[dashSource];
  $("dashNetTitle").textContent=dashSource==="site"?"Valor líquido do site na InfinitePay":dashSource==="olist"?"Valor líquido da loja na InfinitePay":"Valor líquido na InfinitePay";
  $("dashNetHint").textContent=`${who} ${period}, depois das taxas da InfinitePay, para conferir com o app dela.${dashSource!=="site"?" Na loja, o que a Olist não detalha (débito ou forma de pagamento não informada) fica estimado (≈).":""}`;
  setHTML($("dashNet"),
    netStep(r,dashSource==="site"?"Vendido no site":dashSource==="olist"?"Vendido na loja":"Vendido",money(sale),rows.length?`${fmtInt(rows.length)} ${plural(rows.length,"venda","vendas")} · valor dos pedidos`:"nenhuma venda no período",sale,P.sale)+
    netStep(r,"+ Juros pagos pelas clientes",money(interest),withInterest?`${fmtInt(withInterest)} ${plural(withInterest,"venda parcelada","vendas parceladas")} com juros no site`:"nenhuma venda com juros",interest,P.interest,{neutral:true,empty:"sem juros"})+
    feeStep(r,(estFee?"≈ ":"")+money(fee),T,P,{basis:"do valor pago",approx:estFee?"≈ ":"",extra:[estFee?`${money(estFee)} estimados na loja`:"",pix?`${fmtInt(pix)} no Pix, sem taxa`:""].filter(Boolean).join(" · ")})+
    netStep(r,"= Líquido na InfinitePay",(estFee?"≈ ":"")+money(net),(sale?`${pct(net/sale*100)} do vendido · o que entra na conta`:"o que entra na conta")+(pixRounding?` · ${pixRoundingSigned(pixRounding)} do arredondamento do desconto do Pix`:""),net,P.net,{cls:" is-net"}));
  const cell=s=>{const n=s.pay,approx=n.estimated&&n.fee?"≈ ":"";
    const when=s.source==="site"?date(s.order.paid_at||s.order.created_at):new Date(s.time).toLocaleDateString("pt-BR");
    const ref=s.source==="site"?`<button class="link-button" data-click="openOrder" data-args="${esc(JSON.stringify([s.order.id]))}">${esc(orderCodeLabel(s.order))}</button>`:`<span class="net-ref">Loja · nº ${esc(s.olist.numero||"—")}</span>`;
    const form=s.source==="site"?netPayLabel(n):n.label;
    const feeSub=n.fee_percent?feePct(n.fee_percent)+(n.estimated?" · estimada":""):n.method==="pix"?"Pix":"sem taxa";
    return `<tr><td>${esc(when)}</td><td>${ref}</td><td>${esc(form)}</td><td data-label="Venda">${money(n.sale)}</td><td data-label="Pago pela cliente">${money(n.paid)}${paidSub(n)}</td><td data-label="Taxa">${n.fee?approx+"−"+money(n.fee):"grátis"}<small class="net-sub">${esc(feeSub)}</small></td><td><strong>${approx}${money(n.net)}</strong></td></tr>`};
  setHTML($("dashNetTable"),rows.length?`<table class="table net-table"><thead><tr><th>PAGO EM</th><th>PEDIDO</th><th>FORMA</th><th>VENDA</th><th>PAGO PELA CLIENTE</th><th>TAXA</th><th>LÍQUIDO</th></tr></thead><tbody>${rows.map(cell).join("")}<tr class="dc-total"><td>Total</td><td>${fmtInt(rows.length)} ${plural(rows.length,"venda","vendas")}</td><td></td><td data-label="Venda">${money(sale)}</td><td data-label="Pago pela cliente">${money(paid)}</td><td data-label="Taxas">${fee?(estFee?"≈ ":"")+"−"+money(fee):"—"}</td><td>${(estFee?"≈ ":"")+money(net)}</td></tr></tbody></table>`:'<p class="field-help">Nenhuma venda no período.</p>');
  // Também passaram pela InfinitePay, mas não entram na conta acima.
  const inR=o=>inRange(saleTime(o));
  const notes=[];
  if(dashSource!=="olist"){
    const tests=orders.filter(o=>isTestOrder(o)&&o.infinitepay&&inR(o));
    const cancelled=realOrders().filter(o=>o.status==="cancelled"&&o.infinitepay&&inR(o));
    if(tests.length)notes.push(`Fora da conta: ${fmtInt(tests.length)} ${plural(tests.length,"pedido de teste pago","pedidos de teste pagos")} na InfinitePay no período (${money(sumNet(tests,"net"))} de líquido). No app ${plural(tests.length,"ele aparece","eles aparecem")} junto com as vendas.`);
    if(cancelled.length)notes.push(`Fora da conta: ${fmtInt(cancelled.length)} ${plural(cancelled.length,"pedido cancelado","pedidos cancelados")} depois de ${plural(cancelled.length,"pago","pagos")} (${money(sumNet(cancelled,"paid"))}). O estorno sai da conta pelo app da InfinitePay.`);
  }
  const noDetail=rows.filter(s=>s.source==="olist"&&s.pay.method==="unknown").length;
  if(noDetail)notes.push(`${fmtInt(noDetail)} ${plural(noDetail,"venda da loja ainda está","vendas da loja ainda estão")} sem o detalhe do pagamento na importação: ${plural(noDetail,"conta","contam")} como cartão à vista até o detalhe chegar.`);
  const f=infinitePayFees,mf=machineFees,tables=[];
  // Site e loja no crédito: a mesma tabela do link de pagamento (conferido com o app da InfinitePay).
  if(f&&Array.isArray(f.credit))tables.push(`<p class="field-help"><strong>${dashSource==="site"?"Site":dashSource==="olist"?"Loja no crédito":"Site e loja no crédito"}</strong> (${esc(lowerFirst(f.plan||"link de pagamento"))}): Pix ${f.pix?feePct(f.pix):"grátis"}; crédito ${f.credit.map((v,i)=>`${i?i+1+"x":"à vista"} ${feePct(v)}`).join(" · ")}. A taxa é sobre o valor pago pela cliente, com os centavos cortados, como no app. Nas vendas parceladas com juros, a cliente paga a diferença.</p>`);
  if(dashSource!=="site"&&mf&&Array.isArray(mf.tiers)){
    const used=[...new Map(rows.filter(s=>s.source==="olist"&&s.pay.tier).map(s=>[new Date(s.time).toISOString().slice(0,7),s.pay.tier])).entries()].sort((a,b)=>a[0]<b[0]?-1:1);
    tables.push(`<p class="field-help"><strong>Loja no débito</strong> (${esc(lowerFirst(mf.plan||"maquininha"))}, estimado): ${mf.tiers.map(t=>`${esc(t.label)} ${feePct(t.debit)}`).join(" · ")}. A faixa sai do faturamento em cartão do mês anterior (site + loja; o Pix não conta)${used.length?": "+esc(used.map(([m,t])=>monthLabel(m)+" "+t).join(" · ")):""}.</p>`+
      `<p class="field-help">Quando a Olist não diz se foi débito ou crédito, conta crédito à vista (≈). O valor de cada venda da loja é o da Olist: se for diferente do cobrado no app, o líquido muda junto.</p>`);
  }
  setHTML($("dashNetNotes"),notes.map(t=>`<p class="field-help">${esc(t)}</p>`).join("")+(tables.length?`<details class="help-more"><summary>Taxas usadas na conta</summary>${tables.join("")}</details>`:""));
}
/* =====================================================
   RELATÓRIO DE VENDAS DA INFINITEPAY
   O dono baixa o relatório em PDF no app da InfinitePay e envia na Visão geral; o painel lê
   o PDF aqui mesmo (infinitepay-report.js) e grava as transações. Nos dias que o relatório
   cobre, o líquido é o dele, igual ao da conta, também nas vendas da loja (link de
   pagamento, Pix na conta, InfiniteTap). Cada cobrança é ligada à venda registrada (pedido
   do site ou venda da Olist) para mostrar o que não bate.
===================================================== */
let ipReport={transactions:[],coverage:[],last:null,loaded:false,error:""},ipImportMessage="",ipMatchCache=null;
const IP_TYPES={"Link Integrado":"Site","Link de Pagamento":"Link de pagamento","Conta Inteligente":"Conta","InfiniteTap":"InfiniteTap","Cobrança":"Cobrança"};
function ipPrep(t){const v={...t,valor:Number(t.valor||0),liquido:Number(t.liquido||0),taxa:Number(t.taxa||0),parcelas:Number(t.parcelas||1),taxa_percentual:t.taxa_percentual==null?null:Number(t.taxa_percentual)};v.time=window.InfinitePayReport.txTime(v);v.site=window.InfinitePayReport.isSiteTx(v);return v}
async function loadInfinitePayReport(){
  try{
    if(!window.InfinitePayReport)throw new Error("Não foi possível abrir o leitor do relatório. Atualize a página.");
    const d=await api("/api/admin/infinitepay/report");
    ipReport={transactions:(Array.isArray(d.transactions)?d.transactions:[]).map(ipPrep).sort((a,b)=>b.time-a.time),coverage:Array.isArray(d.coverage)?d.coverage:[],last:d.last||null,loaded:true,error:""};
  }catch(e){ipReport={...ipReport,loaded:true,error:e.message}}
  ipMatchCache=null;renderDashboard();
}
function ymdBr(v){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v||""));return m?`${m[3]}/${m[2]}/${m[1]}`:String(v||"")}
// O relatório cobre este momento? Nos pedidos do site vale a hora; nas vendas da Olist, o dia.
function ipCovered(t,precise){const d=ymd(t);return ipReport.coverage.some(c=>d>=c.from&&d<=c.to&&(!precise||d<c.to||!c.until||t<=Date.parse(c.until)))}
function ipCoversRange(r){return ipReport.coverage.some(c=>c.from<=r.to&&c.to>=r.from)}
function ipTxIn(start,end,src){return ipReport.transactions.filter(t=>t.time>=start&&t.time<=end&&(src==="all"||(src==="site")===t.site))}
// "até 04/11/2026 às 19:57" (a hora em que o relatório foi gerado, quando é no último dia).
function ipUntilText(c){if(!c)return "";const u=Date.parse(c.until||"");if(!Number.isFinite(u))return ymdBr(c.to);const d=new Date(u);const endOfDay=d.getHours()===23&&d.getMinutes()===59;return d.toLocaleDateString("pt-BR")+(endOfDay?"":" às "+d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}))}
function ipLastCoverage(r){const list=ipReport.coverage.filter(c=>!r||(c.from<=r.to&&c.to>=r.from));return list.sort((a,b)=>a.to<b.to?1:-1)[0]||null}
function ipFormLabel(t){
  if(t.tipo==="Conta Inteligente"&&t.meio==="Pix")return "Pix na conta";
  const meio=t.meio==="Pix"?"Pix":t.meio==="Débito"?"débito":t.meio==="Crédito"?(t.parcelas>1?`crédito ${t.parcelas}x`:"crédito à vista"):(t.meio||"");
  return [IP_TYPES[t.tipo]||t.tipo||"InfinitePay",meio].filter(Boolean).join(" · ");
}
// Liga as cobranças às vendas registradas (refeito quando pedidos, Olist ou relatório mudam).
function ipMatches(){
  const c=ipMatchCache;
  if(c&&c.orders===orders&&c.olist===olistSales&&c.tx===ipReport.transactions)return c;
  const ok=new Set(olistSaleSituations.map(Number));
  const sales=orders.filter(o=>o.infinitepay&&Number(o.infinitepay.paid)>0&&(o.paid_at||o.created_at)).map(o=>({site:true,time:saleTime(o),amount:Number(o.infinitepay.paid),order:o}))
    .concat(olistSales.filter(s=>ok.has(Number(s.situacao))&&s.data).map(s=>({site:false,day:String(s.data).slice(0,10),amount:Number(s.total||0),olist:s})));
  const m=window.InfinitePayReport.matchTransactions(ipReport.transactions,sales);
  const byTx=new Map(),orderIds=new Set(),olistIds=new Set();
  ipReport.transactions.forEach((t,i)=>{if(m.txSale[i]>=0)byTx.set(t,{sale:sales[m.txSale[i]],kind:m.txKind[i]})});
  sales.forEach((s,j)=>{if(m.saleTx[j].length){if(s.order)orderIds.add(s.order.id);else olistIds.add(s.olist.id)}});
  return ipMatchCache={orders,olist:olistSales,tx:ipReport.transactions,byTx,orderIds,olistIds};
}
function renderDashboardNet(r){
  const panel=$("dashNetPanel");if(!panel)return;
  panel.hidden=false;
  renderIpImport();
  if(ipReport.coverage.length&&ipCoversRange(r))renderDashboardNetReport(r);else renderDashboardNetCalc(r);
}
// Período com relatório: os valores do relatório e, depois dele, o calculado.
function renderDashboardNetReport(r){
  const src=dashSource,M=ipMatches(),cov=ipLastCoverage(r);
  const T=netTotals(r),P=netTotals(r.prev);
  const txs=T.txs.slice().sort((a,b)=>b.time-a.time);
  const rows=T.rows;
  const calc=T.calc.slice().sort((a,b)=>b.time-a.time);
  // Vendas registradas nos dias do relatório que não aparecem nele.
  const missing=rows.filter(s=>ipCovered(s.time,s.source==="site")&&!(s.source==="site"?M.orderIds.has(s.order.id):M.olistIds.has(s.olist.id))).sort((a,b)=>b.time-a.time);
  const cents=v=>Math.round(Number(v||0)*100),sum=(list,f)=>list.reduce((n,x)=>n+cents(f(x)),0)/100;
  const charged=T.charged,fee=T.fee,net=T.net;
  const estFee=sum(calc.filter(s=>s.pay.estimated),s=>s.pay.fee),approx=estFee?"≈ ":"";
  const sold=T.sold,until=ipUntilText(cov);
  const who={site:"Vendas do site",olist:"Vendas da loja",all:"Vendas do site e da loja"}[src];
  $("dashNetTitle").textContent=src==="site"?"Valor líquido do site na InfinitePay":src==="olist"?"Valor líquido da loja na InfinitePay":"Valor líquido na InfinitePay";
  $("dashNetHint").textContent=`${who} ${r.label}, conferidas com o relatório da InfinitePay até ${until}: os valores são os do relatório, iguais aos da conta.${calc.length?" Depois disso, o líquido é calculado pelas taxas"+(src!=="site"?" (na loja, estimado ≈)":"")+" até você enviar um relatório novo.":""}`;
  setHTML($("dashNet"),
    netStep(r,src==="site"?"Vendido no site":src==="olist"?"Vendido na loja":"Vendido",money(sold),rows.length?`${fmtInt(rows.length)} ${plural(rows.length,"venda registrada","vendas registradas")}${src==="site"?"":src==="olist"?" na Olist":" (site e Olist)"}`:"nenhuma venda registrada",sold,P.sold)+
    netStep(r,"Cobrado na InfinitePay",money(charged),`${fmtInt(txs.length)} ${plural(txs.length,"cobrança aprovada","cobranças aprovadas")} no relatório${calc.length?` + ${fmtInt(calc.length)} ${plural(calc.length,"venda","vendas")} depois dele`:""}`,charged,P.charged)+
    feeStep(r,approx+money(fee),T,P,{basis:"do cobrado",approx,extra:estFee?`${money(estFee)} estimados`:""})+
    netStep(r,"= Líquido na InfinitePay",approx+money(net),"o que entra na conta",net,P.net,{cls:" is-net"}));
  const txRow=t=>{
    const m=M.byTx.get(t);let ref,venda="—";
    if(m&&m.sale.order){const o=m.sale.order;ref=`<button class="link-button" data-click="openOrder" data-args="${esc(JSON.stringify([o.id]))}">${esc(orderCodeLabel(o))}</button>${isTestOrder(o)?'<small class="net-sub">pedido de teste</small>':""}`;venda=money(o.total)}
    else if(m){const s=m.sale.olist;ref=`<span class="net-ref">Loja · nº ${esc(s.numero||"—")}</span>${m.kind==="dividido"?'<small class="net-sub">paga em duas cobranças</small>':m.kind==="centavos"?`<small class="net-sub">na Olist: ${esc(money(s.total))}</small>`:""}`;venda=money(s.total)}
    else ref=`<span class="net-ref is-missing">${t.site?"Sem pedido no painel":"Sem venda na Olist"}</span>`;
    const pctText=t.taxa_percentual!=null&&t.taxa?feePct(t.taxa_percentual)+" · ":"";
    return `<tr><td>${esc(ymdBr(t.data))}${t.hora?" "+esc(t.hora):""}</td><td>${ref}</td><td>${esc(ipFormLabel(t))}</td><td data-label="Venda">${venda}</td><td data-label="Pago pela cliente">${money(t.valor)}</td><td data-label="Taxa">${t.taxa?"−"+money(t.taxa):"grátis"}<small class="net-sub">${esc(pctText)}relatório</small></td><td><strong>${money(t.liquido)}</strong></td></tr>`;
  };
  const calcRow=s=>{const n=s.pay,ap=n.estimated&&n.fee?"≈ ":"";
    const when=s.source==="site"?date(s.order.paid_at||s.order.created_at):new Date(s.time).toLocaleDateString("pt-BR");
    const ref=s.source==="site"?`<button class="link-button" data-click="openOrder" data-args="${esc(JSON.stringify([s.order.id]))}">${esc(orderCodeLabel(s.order))}</button>`:`<span class="net-ref">Loja · nº ${esc(s.olist.numero||"—")}</span>`;
    const feeSub=(n.fee_percent?feePct(n.fee_percent)+" · ":"")+(n.estimated?"estimada":"calculada");
    return `<tr><td>${esc(when)}</td><td>${ref}</td><td>${esc(s.source==="site"?netPayLabel(n):n.label)}</td><td data-label="Venda">${money(n.sale)}</td><td data-label="Pago pela cliente">${money(n.paid)}${paidSub(n)}</td><td data-label="Taxa">${n.fee?ap+"−"+money(n.fee):"grátis"}<small class="net-sub">${esc(feeSub)}</small></td><td><strong>${ap}${money(n.net)}</strong></td></tr>`};
  const missRow=s=>{const ref=s.source==="site"?`<button class="link-button" data-click="openOrder" data-args="${esc(JSON.stringify([s.order.id]))}">${esc(orderCodeLabel(s.order))}</button>`:`<span class="net-ref">Loja · nº ${esc(s.olist.numero||"—")}</span>`;
    return `<tr class="is-missing"><td>${esc(new Date(s.time).toLocaleDateString("pt-BR"))}</td><td>${ref}</td><td>${esc(s.payment)}</td><td data-label="Venda">${money(s.total)}</td><td data-label="Na InfinitePay">não aparece no relatório</td><td></td><td>—</td></tr>`};
  const all=txs.length+calc.length+missing.length;
  setHTML($("dashNetTable"),all?`<table class="table net-table"><thead><tr><th>PAGO EM</th><th>VENDA REGISTRADA</th><th>FORMA</th><th>VALOR DA VENDA</th><th>PAGO PELA CLIENTE</th><th>TAXA</th><th>LÍQUIDO</th></tr></thead><tbody>${calc.map(calcRow).join("")}${txs.map(txRow).join("")}${missing.map(missRow).join("")}<tr class="dc-total"><td>Total</td><td>${fmtInt(txs.length+calc.length)} ${plural(txs.length+calc.length,"cobrança","cobranças")}</td><td></td><td data-label="Vendido">${money(sold)}</td><td data-label="Cobrado">${money(charged)}</td><td data-label="Taxas">${fee?approx+"−"+money(fee):"—"}</td><td>${approx+money(net)}</td></tr></tbody></table>`:'<p class="field-help">Nenhuma venda no período.</p>');
  const notes=[];
  const noSale=txs.filter(t=>!M.byTx.get(t)),noSaleStore=noSale.filter(t=>!t.site),noSaleSite=noSale.filter(t=>t.site);
  if(noSaleStore.length)notes.push(`${fmtInt(noSaleStore.length)} ${plural(noSaleStore.length,"cobrança da loja na InfinitePay não tem","cobranças da loja na InfinitePay não têm")} venda igual na Olist (${money(sum(noSaleStore,t=>t.valor))}): venda não lançada na Olist, Pix recebido na conta ou valor diferente. Na lista ${plural(noSaleStore.length,"ela aparece","elas aparecem")} como "Sem venda na Olist".`);
  if(noSaleSite.length)notes.push(`${fmtInt(noSaleSite.length)} ${plural(noSaleSite.length,"pagamento do site no relatório não tem","pagamentos do site no relatório não têm")} pedido pago no painel (${money(sum(noSaleSite,t=>t.valor))}).`);
  const missStore=missing.filter(s=>s.source==="olist"),missSite=missing.filter(s=>s.source==="site");
  if(missStore.length)notes.push(`${fmtInt(missStore.length)} ${plural(missStore.length,"venda da Olist não tem","vendas da Olist não têm")} cobrança igual no relatório (${money(sumTotal(missStore))}): paga em dinheiro ou outra maquininha, ou com valor na Olist diferente do cobrado. ${plural(missStore.length,"Ela não entra","Elas não entram")} no líquido.`);
  if(missSite.length)notes.push(`${fmtInt(missSite.length)} ${plural(missSite.length,"pedido pago no site não aparece","pedidos pagos no site não aparecem")} no relatório (${money(sumTotal(missSite))}).`);
  const cents2=txs.filter(t=>{const m=M.byTx.get(t);return m&&m.kind==="centavos"});
  if(cents2.length)notes.push(`${fmtInt(cents2.length)} ${plural(cents2.length,"venda tem","vendas têm")} centavos de diferença entre a Olist e a InfinitePay: vale o valor cobrado na InfinitePay.`);
  const tests=txs.filter(t=>{const m=M.byTx.get(t);return m&&m.sale.order&&isTestOrder(m.sale.order)});
  if(tests.length)notes.push(`Inclui ${fmtInt(tests.length)} ${plural(tests.length,"pedido de teste","pedidos de teste")} do site (${money(sum(tests,t=>t.liquido))} de líquido), porque ${plural(tests.length,"ele também entrou","eles também entraram")} na conta da InfinitePay.`);
  const f=infinitePayFees,tables=[];
  if(calc.length&&f&&Array.isArray(f.credit))tables.push(`<p class="field-help"><strong>Depois do relatório</strong> (${esc(lowerFirst(f.plan||"link de pagamento"))}): Pix ${f.pix?feePct(f.pix):"grátis"}; crédito ${f.credit.map((v,i)=>`${i?i+1+"x":"à vista"} ${feePct(v)}`).join(" · ")}. A taxa é sobre o valor pago pela cliente, com os centavos cortados, como no app.</p>`);
  setHTML($("dashNetNotes"),notes.map(t=>`<p class="field-help">${esc(t)}</p>`).join("")+(tables.length?`<details class="help-more"><summary>Taxas usadas na conta</summary>${tables.join("")}</details>`:""));
}
// Situação do relatório e o botão para enviar um novo.
function renderIpImport(){
  const box=$("ipReportStatus");if(!box)return;
  const cov=ipLastCoverage(null),last=ipReport.last;
  let text;
  if(!ipReport.loaded)text="Carregando o relatório da InfinitePay…";
  else if(ipReport.error)text="Relatório da InfinitePay: "+ipReport.error;
  else if(!cov)text="Envie o Relatório de Vendas em PDF que você baixa no app da InfinitePay. Com ele, o líquido do painel fica igual ao da sua conta, também nas vendas da loja.";
  else{
    const first=ipReport.transactions.length?ipReport.transactions[ipReport.transactions.length-1].data:cov.from;
    text=`Conferido com o relatório da InfinitePay de ${ymdBr(first)} até ${ipUntilText(cov)}${last&&last.imported_at?` (enviado em ${new Date(last.imported_at).toLocaleDateString("pt-BR")})`:""}. Para atualizar, envie um relatório novo: pode ser só dos últimos dias.`;
  }
  box.textContent=(ipImportMessage?ipImportMessage+" ":"")+text;
  box.classList.toggle("is-error",!!ipReport.error);
}
async function importInfinitePayReport(file){
  const box=$("ipReportStatus"),button=$("ipReportButton"),input=$("ipReportFile");
  if(!file||!button||button.disabled)return;
  const say=t=>{if(box){box.textContent=t;box.classList.remove("is-error")}};
  button.disabled=true;ipImportMessage="";
  try{
    if(!window.InfinitePayReport)throw new Error("Não foi possível abrir o leitor do relatório. Atualize a página.");
    if(file.size>20*1024*1024)throw new Error("O arquivo é grande demais para um relatório (máximo de 20 MB).");
    say("Lendo o relatório…");
    const rep=await window.InfinitePayReport.readInfinitePayReport(new Uint8Array(await file.arrayBuffer()));
    if(!rep.rows.length)throw new Error("Não encontrei vendas neste PDF. Confira se é o Relatório de Vendas da InfinitePay.");
    if(rep.unread.length)throw new Error(`Não consegui ler ${fmtInt(rep.unread.length)} ${plural(rep.unread.length,"linha","linhas")} do relatório. Nada foi gravado.`);
    if(!rep.summary.from||!rep.summary.to)throw new Error("Não encontrei o período do relatório. Nada foi gravado.");
    if(!rep.check.ok)throw new Error(`A soma das vendas aprovadas lidas (${money(rep.check.got.net)} líquido) não bate com o total do relatório (${money(rep.check.expected.net)}). Nada foi gravado.`);
    const rows=window.InfinitePayReport.numberRows(rep.rows);
    const batch=(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,12)).toLowerCase();
    const summary={from:rep.summary.from,to:rep.summary.to,created:rep.summary.created,count:rows.length,total:rep.summary.total,fees:rep.summary.fees,net:rep.summary.net};
    const size=400,parts=Math.max(1,Math.ceil(rows.length/size));
    for(let p=0;p<parts;p++){
      say(`Gravando ${fmtInt(rows.length)} ${plural(rows.length,"transação","transações")} do relatório… ${p+1} de ${parts}`);
      await api("/api/admin/infinitepay/report",{method:"POST",body:JSON.stringify({batch,part:p,parts,summary,rows:rows.slice(p*size,(p+1)*size)})});
    }
    ipImportMessage=`Relatório gravado: ${fmtInt(rep.check.approved)} ${plural(rep.check.approved,"venda aprovada","vendas aprovadas")}, ${money(rep.check.got.net)} a receber no período, igual ao total do relatório.`;
    await loadInfinitePayReport();
  }catch(e){ipImportMessage="";if(box){box.textContent=e.message;box.classList.add("is-error")}}
  finally{button.disabled=false;if(input)input.value=""}
}
(function(){
  const button=$("ipReportButton"),input=$("ipReportFile");
  if(button&&input){button.addEventListener("click",()=>input.click());input.addEventListener("change",()=>importInfinitePayReport(input.files&&input.files[0]))}
})();
function groupSales(list,keyFn){
  const map=new Map();list.forEach(s=>{const k=keyFn(s),x=map.get(k)||{name:k,revenue:0,count:0};x.revenue+=Number(s.total||0);x.count++;map.set(k,x)});
  return [...map.values()];
}
// Barras horizontais em ordem (maior primeiro), uma cor só; o número fica escrito ao lado.
function renderRankList(box,rows,by,opts={}){
  if(!box)return;
  rows=rows.filter(r=>r[by]>0).sort((a,b)=>b[by]-a[by]||b.revenue-a.revenue).slice(0,opts.limit||6);
  if(!rows.length){setHTML(box,`<p class="rank-empty">${esc(opts.empty||"Nenhuma venda no período.")}</p>`);return}
  const total=rows.reduce((n,r)=>n+r[by],0),max=rows[0][by];
  setHTML(box,rows.map(r=>{
    const share=total?Math.round(r[by]/total*100):0;
    const value=by==="revenue"?money(r.revenue):`${fmtInt(r.count)} ${plural(r.count,"venda","vendas")}`;
    const sub=opts.sub?opts.sub(r):(by==="revenue"?`${fmtInt(r.count)} ${plural(r.count,"venda","vendas")} · ${share}%`:`${share}% · ${money(r.revenue)}`);
    return `<div class="rank-row">${r.img!==undefined?`<span class="rank-thumb">${r.img?`<img src="${esc(r.img)}" alt="" loading="lazy" data-img-error="hide">`:""}</span>`:""}<div class="rank-body"><div class="rank-top"><span class="rank-name">${esc(r.name)}</span><strong class="rank-value">${esc(value)}</strong></div><div class="rank-track"><i data-w="${(r[by]/max*100).toFixed(1)}"></i></div><small class="rank-sub">${esc(sub)}</small></div></div>`;
  }).join(""));
  box.querySelectorAll("[data-w]").forEach(el=>{el.style.width=Math.max(2,Number(el.dataset.w))+"%"});
}
function renderTopProducts(list){
  const map=new Map();
  list.forEach(s=>s.items.forEach(i=>{const x=map.get(i.key)||{name:i.name,product_id:i.product_id,revenue:0,count:0,pieces:0};x.revenue+=i.total;x.pieces+=i.qty;x.count++;map.set(i.key,x)}));
  const rows=[...map.values()].map(r=>{const p=r.product_id?products.find(x=>String(x.id)===String(r.product_id)):null;return {...r,img:p&&Array.isArray(p.images)&&p.images[0]?smallPhoto(p.images[0]):""}});
  const noItems=list.filter(s=>!s.hasItems).length;
  renderRankList($("dashTopProducts"),rows,"revenue",{limit:5,sub:r=>`${fmtInt(r.pieces)} ${plural(r.pieces,"peça","peças")}`,empty:noItems?"Os itens das vendas da Olist ainda estão sendo importados.":"Nenhuma venda no período."});
}
// Expedição: onde estão os pedidos pagos agora (não depende do período).
function renderDashboardPipeline(){
  const box=$("dashPipeline");if(!box)return;
  const real=realOrders(),n=st=>real.filter(o=>o.status===st&&!(st==="paid"&&o.approval_status==="pending")).length;
  const steps=[["Para separar",n("paid"),"pagos, esperando a separação"],["Separando",n("processing"),"em separação"],["A caminho",n("shipped"),"enviados"],["Entregues",n("delivered"),"desde o início"]];
  setHTML(box,steps.map(([label,count,sub],i)=>`<button type="button" class="pipeline-step${i<3&&count?" has-items":""}" data-click="goTo" data-args="${esc(JSON.stringify(["orders"]))}"><span class="pipeline-label">${esc(label)}</span><strong>${fmtInt(count)}</strong><small>${esc(sub)}</small></button>`).join('<span class="pipeline-arrow" aria-hidden="true">→</span>'));
}
function renderDashboardTodo(){
  const real=realOrders();
  const toShip=real.filter(o=>["paid","processing"].includes(o.status)&&o.approval_status!=="pending").length;
  const approvals=real.filter(o=>o.approval_status==="pending"&&o.status==="paid").length;
  const refunds=real.filter(o=>o.status==="cancelled"&&o.refund_status==="pending").length;
  const low=products.reduce((n,p)=>n+(p.product_variants||[]).filter(v=>v.stock<=2&&v.active).length,0);
  const badge=$("navOrdersBadge");if(badge){badge.textContent=toShip>99?"99+":String(toShip);badge.hidden=!toShip}
  const box=$("dashboardTodo");if(!box)return;
  const items=[
    [toShip,"pedido pago para separar e enviar","pedidos pagos para separar e enviar",["orders"]],
    [approvals,"pré-venda aguardando você aceitar ou recusar","pré-vendas aguardando você aceitar ou recusar",["orders"]],
    [refunds,"estorno pendente na InfinitePay","estornos pendentes na InfinitePay",["orders"]],
    [low,"cor com estoque baixo (até 2 peças)","cores com estoque baixo (até 2 peças)",["stock","stock"]]
  ].filter(x=>x[0]>0);
  setHTML(box,items.length?`<p class="todo-title">Precisa da sua atenção</p>`+items.map(([n,one,many,args])=>`<button type="button" class="todo-item" data-click="goTo" data-args="${esc(JSON.stringify(args))}"><strong>${n}</strong><span>${n===1?one:many}</span><i aria-hidden="true">›</i></button>`).join(""):'<p class="todo-empty">Tudo em dia: nenhum pedido para enviar, nenhuma pré-venda esperando resposta e nenhum estorno pendente.</p>');
}
