const $=id=>document.getElementById(id);
async function api(path,options={}){const r=await fetch(path,{credentials:"same-origin",headers:{"Content-Type":"application/json",...(options.headers||{})},...options});let d=null;try{d=await r.json()}catch{}if(!r.ok){const e=new Error(d?.message||"Não foi possível concluir a operação.");e.status=r.status;throw e}return d}
let products=[],orders=[],editingProduct=null,productImageDraft=[],productImageFiles=[];

let analyticsData=null;
async function loadAnalytics(){try{$("analyticsError").textContent="";analyticsData=await api("/api/admin/analytics?days="+Number($("analyticsDays").value||30));renderAnalytics()}catch(e){$("analyticsError").textContent=e.message}}
function renderAnalytics(){
 const d=analyticsData.summary||{}, k=[["Visitantes únicos",fmtInt(d.visitors)],["Visualizações",fmtInt(d.pageViews)],["Pedidos pagos",fmtInt(d.paidOrders)],["Faturamento bruto",money(d.grossRevenue)],["Ticket médio",money(d.ticketAverage)],["Conversão",pct(d.conversionRate)],["Carrinhos ativos",fmtInt(d.activeCarts)],["Valor em abandono",money(d.abandonedValue)]];
 $("analyticsKpis").innerHTML=k.map(x=>'<div class="analytics-kpi"><span>'+x[0]+'</span><strong>'+x[1]+'</strong></div>').join("");
 const maxV=Math.max(1,...(analyticsData.series||[]).map(x=>Number(x.visitors||0))), maxR=Math.max(1,...(analyticsData.series||[]).map(x=>Number(x.revenue||0)));
 $("analyticsChart").innerHTML='<div class="chart-bars">'+(analyticsData.series||[]).slice(-14).map(x=>'<div class="chart-day"><div class="bar-wrap"><i style="height:'+Math.max(4,(x.visitors/maxV)*150)+'px"></i><b style="height:'+Math.max(4,(x.revenue/maxR)*150)+'px"></b></div><span>'+x.date.slice(5)+'</span></div>').join("")+'</div><div class="chart-legend"><span>Visitas</span><span>Faturamento</span></div>';
 const f=[["Visitas",d.visitors],["Add ao carrinho",d.addToCart],["Checkout",d.checkoutStarted],["Pagos",d.paidOrders]]; $("analyticsFunnel").innerHTML=f.map((x,i)=>'<div class="funnel-row"><span>'+x[0]+'</span><strong>'+fmtInt(x[1])+'</strong>'+(i?'<em>'+pct(Number(f[i-1][1])?x[1]/f[i-1][1]*100:0)+'</em>':'')+'</div>').join("");
 $("analyticsCarts").innerHTML='<div class="mini-stats"><div><span>Abandono estimado</span><strong>'+pct(d.abandonmentRate)+'</strong></div><div><span>Carrinhos convertidos</span><strong>'+fmtInt(d.convertedCarts)+'</strong></div></div><p class="analytics-note">'+fmtInt(d.activeCarts)+' carrinhos ativos representam '+money(d.abandonedValue)+'.</p>';
 const pays=Object.entries(analyticsData.paymentMethods||{});$("analyticsPayments").innerHTML=pays.length?'<table class="table"><thead><tr><th>MEIO</th><th>RECEITA</th></tr></thead><tbody>'+pays.map(x=>'<tr><td>'+esc(x[0])+'</td><td>'+money(x[1])+'</td></tr>').join("")+'</tbody></table>':'<p>Nenhum pagamento.</p>';
 const tops=analyticsData.topProducts||[];$("analyticsTopProducts").innerHTML=tops.length?'<table class="table"><thead><tr><th>PRODUTO</th><th>UNID.</th><th>RECEITA</th></tr></thead><tbody>'+tops.map(x=>'<tr><td>'+esc(x.key)+'</td><td>'+fmtInt(x.units)+'</td><td>'+money(x.revenue)+'</td></tr>').join("")+'</tbody></table>':'<p>Nenhuma venda.</p>';
 $("analyticsOrders").innerHTML=orderTable(analyticsData.recentOrders||[]);
 const cs=analyticsData.recentCarts||[];$("analyticsRecentCarts").innerHTML=cs.length?'<table class="table"><thead><tr><th>ATIVIDADE</th><th>CLIENTE</th><th>ITENS</th><th>TOTAL</th><th>STATUS</th></tr></thead><tbody>'+cs.map(x=>'<tr><td>'+date(x.last_activity_at)+'</td><td>'+esc(x.customer_name||x.customer_email||"Visitante")+'</td><td>'+fmtInt(Array.isArray(x.items)?x.items.reduce((n,i)=>n+Number(i.quantity||1),0):0)+'</td><td>'+money(x.total)+'</td><td>'+esc(x.status)+'</td></tr>').join("")+'</tbody></table>':'<p>Nenhum carrinho.</p>';
}
function fmtInt(v){return new Intl.NumberFormat("pt-BR").format(Number(v||0))}
function pct(v){return Number(v||0).toLocaleString("pt-BR",{maximumFractionDigits:1})+"%"}

document.addEventListener("DOMContentLoaded",init);
async function init(){
  const loginForm=$("loginForm"); if(loginForm) loginForm.addEventListener("submit",login);
  const logoutButton=$("logoutButton"); if(logoutButton) logoutButton.addEventListener("click",logout);
  document.querySelectorAll(".nav-button").forEach(b=>b.onclick=()=>showSection(b.dataset.section));
  document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>showSection(b.dataset.go));
  const newProductButton=$("newProductButton"); if(newProductButton) newProductButton.onclick=()=>openProduct();
  const closeModalButton=$("closeModal"); if(closeModalButton) closeModalButton.onclick=closeProduct;
  const cancelProductButton=$("cancelProduct"); if(cancelProductButton) cancelProductButton.onclick=closeProduct;
  const addVariantButton=$("addVariant"); if(addVariantButton) addVariantButton.onclick=()=>addVariant();
  const productForm=$("productForm"); if(productForm) productForm.onsubmit=saveProduct;
  const productSearch=$("productSearch"); if(productSearch) productSearch.oninput=renderProducts;
  bindProductImageDropzone();
  const refreshOrders=$("refreshOrders"); if(refreshOrders) refreshOrders.onclick=loadOrders;
  const refreshStock=$("refreshStock"); if(refreshStock) refreshStock.onclick=loadStockMovements;
  const refreshAnalytics=$("refreshAnalytics"); if(refreshAnalytics) refreshAnalytics.onclick=loadAnalytics;
  const analyticsDays=$("analyticsDays"); if(analyticsDays) analyticsDays.onchange=loadAnalytics;
  try{const s=await api("/api/admin/session");await enterApp(s)}catch{showLogin()}
}
function showLogin(){$("loginView").classList.remove("hidden");$("appView").classList.add("hidden");$("loginEmail").focus()}
async function login(e){e.preventDefault();$("loginError").textContent="";try{await enterApp(await api("/api/admin/login",{method:"POST",body:JSON.stringify({email:$("loginEmail").value.trim(),password:$("loginPassword").value})}))}catch(e){$("loginError").textContent=e.message}}
async function logout(){try{await api("/api/admin/logout",{method:"POST"})}catch{}products=[];orders=[];showLogin();$("loginPassword").value=""}
async function enterApp(s){$("loginView").classList.add("hidden");$("appView").classList.remove("hidden");$("adminEmail").textContent=s.email||"Administrador";try{await Promise.all([loadProducts(),loadOrders(),loadStockMovements()]);renderDashboard()}catch(e){console.error("Falha ao carregar dados do painel:",e);$("loginError").textContent="Login realizado, mas houve um erro ao carregar os dados. Atualize a página e tente novamente.";renderDashboard()}}
function showSection(s){document.querySelectorAll(".section").forEach(x=>x.classList.add("hidden"));$(s+"Section").classList.remove("hidden");document.querySelectorAll(".nav-button").forEach(b=>b.classList.toggle("active",b.dataset.section===s));$("pageTitle").textContent={dashboard:"Visão geral",products:"Produtos",carousel:"Carrossel",orders:"Pedidos",stock:"Estoque",analytics:"Analytics & Financeiro"}[s];if(s==="analytics")loadAnalytics();if(s==="products")renderProducts();if(s==="carousel"&&typeof window.loadCarousel==="function")window.loadCarousel();if(s==="orders")renderOrders();if(s==="stock")renderStock()}
async function loadProducts(){const d=await api("/api/admin/products");products=d.products||[];renderProducts();renderStock();renderDashboard()}
async function loadStockMovements(){try{const d=await api("/api/admin/stock/movements");renderStockMovements(d.movements||[])}catch(e){$("stockMovements").innerHTML='<p>'+esc(e.message)+'</p>'}}
async function loadOrders(){const d=await api("/api/admin/orders");orders=d.orders||[];renderOrders();renderDashboard()}
function renderDashboard(){$("statProducts").textContent=products.filter(p=>p.active).length;$("statOrders").textContent=orders.length;$("statPaid").textContent=orders.filter(o=>["paid","processing","shipped","delivered"].includes(o.status)).length;$("statLowStock").textContent=products.reduce((n,p)=>n+(p.product_variants||[]).filter(v=>v.stock<=2&&v.active).length,0);$("recentOrders").innerHTML=orderTable(orders.slice(0,5))}
function renderProducts(){const q=($("productSearch").value||"").toLowerCase();const list=products.filter(p=>(p.name+" "+(p.sku||"")).toLowerCase().includes(q));$("productsGrid").innerHTML=list.map(p=>{const img=Array.isArray(p.images)&&p.images[0]?p.images[0]:"";const stock=(p.product_variants||[]).reduce((n,v)=>n+Number(v.stock||0),0);return `<article class="admin-product"><img src="${esc(img)}" onerror="this.style.visibility='hidden'"><div class="admin-product-body"><h3>${esc(p.name)}</h3><div class="meta">${esc(p.sku||"SEM SKU")} · ${money(p.sale_price||p.price)} · estoque ${stock}</div><div class="admin-product-actions"><button onclick="openProduct('${p.id}')">EDITAR</button><button class="secondary" onclick="toggleProduct('${p.id}',${!p.active})">${p.active?"DESATIVAR":"ATIVAR"}</button></div></div></article>`}).join("")||"<p>Nenhum produto encontrado.</p>"}
function renderStock(){const rows=[];products.forEach(p=>(p.product_variants||[]).forEach(v=>rows.push([p,v])));$("stockTable").innerHTML=`<table class="table"><thead><tr><th>PRODUTO</th><th>COR</th><th>SKU</th><th>ESTOQUE</th><th>STATUS</th><th></th></tr></thead><tbody>${rows.map(([p,v])=>`<tr><td>${esc(p.name)}</td><td>${esc(v.color)}</td><td>${esc(v.sku||p.sku||"")}</td><td class="${v.stock<=2?"stock-low":""}">${v.stock}</td><td>${v.active?"Ativo":"Inativo"}</td><td><button class="secondary small-button" onclick="adjustStock('${v.id}','${esc(p.name+" — "+v.color)}',${Number(v.stock||0)})">AJUSTAR</button></td></tr>`).join("")||"<tr><td colspan='6'>Nenhuma variação cadastrada.</td></tr>"}</tbody></table>`}
function renderStockMovements(list){if(!list.length){$("stockMovements").innerHTML="<p>Nenhuma movimentação registrada.</p>";return}$("stockMovements").innerHTML=`<table class="table"><thead><tr><th>DATA</th><th>PRODUTO</th><th>COR</th><th>TIPO</th><th>QTD.</th><th>MOTIVO</th><th>POR</th></tr></thead><tbody>${list.map(m=>{const v=m.product_variants||{},p=v.products||{};return `<tr><td>${date(m.created_at)}</td><td>${esc(p.name||"—")}</td><td>${esc(v.color||"—")}</td><td>${esc(m.movement_type||"—")}</td><td class="${Number(m.quantity_delta)<0?"stock-negative":"stock-positive"}">${Number(m.quantity_delta)>0?"+":""}${m.quantity_delta}</td><td>${esc(m.reason||"—")}</td><td>${esc(m.created_by||"—")}</td></tr>`}).join("")}</tbody></table>`}

async function adjustStock(variantId,label,current){const raw=window.prompt(`Ajuste de estoque para ${label}.\nEstoque atual: ${current}\nInforme a quantidade a alterar (ex.: +5 ou -2):`);if(raw===null)return;const delta=Number(String(raw).replace(",","."));if(!Number.isInteger(delta)||delta===0){window.alert("Informe um número inteiro diferente de zero.");return}const reason=window.prompt("Motivo do ajuste:","Reposição de estoque");if(reason===null)return;try{await api("/api/admin/stock/adjust",{method:"POST",body:JSON.stringify({variant_id:variantId,delta,movement_type:delta>0?"restock":"adjustment",reason})});await Promise.all([loadProducts(),loadStockMovements()]);}catch(e){window.alert(e.message)}}

function orderTable(list){if(!list.length)return "<p>Nenhum pedido encontrado.</p>";return `<table class="table order-table"><thead><tr><th>PEDIDO</th><th>CLIENTE</th><th>DATA</th><th>TOTAL</th><th>STATUS</th><th></th></tr></thead><tbody>${list.map(o=>`<tr><td><button class="link-button" onclick="openOrder('${o.id}')">${esc(o.order_nsu||"—")}</button></td><td>${esc(o.customer_name||"—")}</td><td>${date(o.created_at)}</td><td>${money(o.total)}</td><td><span class="badge ${esc(o.status||"pending")}">${statusLabel(o.status)}</span></td><td><button class="secondary small-button" onclick="openOrder('${o.id}')">DETALHES</button></td></tr>`).join("")}</tbody></table>`}
function renderOrders(){$("ordersTable").innerHTML=orderTable(orders)}
function statusLabel(s){return({pending:"Aguardando pagamento",paid:"PAGO",processing:"SEPARANDO",shipped:"ENVIADO",delivered:"ENTREGUE"})[s]||s||"—"}
function openOrder(id){const o=orders.find(x=>String(x.id)===String(id));if(!o)return;$("orderModalTitle").textContent=o.order_nsu||"Pedido";$("orderDetails").innerHTML=orderDetail(o);$("orderModal").classList.remove("hidden")}
function closeOrder(){$("orderModal").classList.add("hidden")}
function orderDetail(o){const a=o.customer_address||{},p=(o.payments||[])[0]||{},items=o.order_items||[];const address=[a.street&&a.number?`${a.street}, ${a.number}`:a.street||"",a.complement||"",a.neighborhood||"",a.cep||"",a.city&&a.state?`${a.city} - ${a.state}`:a.city||a.state||""].filter(Boolean).join(" · ");return `<div class="order-summary-grid"><div class="detail-card"><h3>Cliente</h3><p><strong>${esc(o.customer_name||"—")}</strong></p><p>${esc(o.customer_email||"—")}</p><p>Telefone: ${esc(o.customer_phone||"—")}</p><p>WhatsApp rastreio: <strong>${esc(o.customer_whatsapp||"—")}</strong></p><p>CPF: ${esc(o.customer_cpf||"—")}</p></div><div class="detail-card"><h3>Entrega</h3><p>${esc(address||"—")}</p><p>Frete: ${money(o.shipping)}</p></div><div class="detail-card"><h3>Pagamento</h3><p>Status: <strong>${esc(statusLabel(o.status))}</strong></p><p>Transação: ${esc(o.transaction_nsu||p.transaction_nsu||"—")}</p><p>Parcelas: ${esc(o.installments||p.installments||"—")}</p><p>Pago em: ${date(o.paid_at||p.created_at)}</p>${o.receipt_url||p.receipt_url?`<a href="${esc(o.receipt_url||p.receipt_url)}" target="_blank" rel="noopener">Abrir comprovante</a>`:""}</div><div class="detail-card"><h3>Resumo</h3><p>Subtotal: ${money(o.subtotal)}</p><p>Frete: ${money(o.shipping)}</p><p class="total-line">Total: ${money(o.total)}</p></div></div><div class="detail-card"><h3>Produtos</h3><div class="order-items">${items.length?items.map(i=>`<div class="order-item"><div><strong>${esc(i.product_name)}</strong><span>${esc(i.variant_color||"Sem cor")} · SKU ${esc(i.sku||"—")}</span></div><div>${i.quantity} × ${money(i.unit_price)}<br><strong>${money(i.total_price)}</strong></div></div>`).join(""):"<p>Nenhum item registrado.</p>"}</div></div><div class="detail-card"><h3>Expedição</h3><div class="status-actions"><label>Status<select id="orderStatus">${["paid","processing","shipped","delivered"].map(s=>`<option value="${s}" ${o.status===s?"selected":""}>${statusLabel(s)}</option>`).join("")}</select></label><label>Transportadora<input id="shippingCarrier" value="${esc(o.shipping_carrier||"")}" placeholder="Ex.: Correios"></label><label>Código de rastreio<input id="trackingCode" value="${esc(o.tracking_code||"")}" placeholder="Código"></label><label>Link de rastreio<input id="trackingUrl" value="${esc(o.tracking_url||"")}" placeholder="https://..."></label></div><p class="whatsapp-admin-status">WhatsApp: <strong>${o.whatsapp_tracking_sent_at?"enviado":"automático"}</strong>${o.whatsapp_tracking_sent_at?" · enviado em "+date(o.whatsapp_tracking_sent_at):""}</p><p class="whatsapp-admin-status">E-mail de atualização: <strong>${esc(o.tracking_email_status||"não enviado")}</strong>${o.tracking_email_sent_at?" · enviado em "+date(o.tracking_email_sent_at):""}</p><div id="orderUpdateError" class="error"></div><div class="modal-actions"><button class="secondary" onclick="closeOrder()">FECHAR</button><button class="secondary" onclick="sendTrackingWhatsApp('${o.id}')">ENVIAR WHATSAPP</button><button class="secondary" onclick="sendTrackingEmail('${o.id}')">ENVIAR E-MAIL</button><button onclick="saveOrderStatus('${o.id}')">SALVAR STATUS</button></div></div>`}
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

function openProduct(id=null){editingProduct=id?products.find(p=>p.id===id):null;productImageDraft=Array.isArray(editingProduct?.images)?[...editingProduct.images]:[];productImageFiles=[];$("modalTitle").textContent=editingProduct?"Editar produto":"Novo produto";$("productId").value=editingProduct?.id||"";$("productName").value=editingProduct?.name||"";$("productSku").value=editingProduct?.sku||"";$("productCategory").value=editingProduct?.category||"bolsas";$("productPrice").value=editingProduct?.price??"";$("productSalePrice").value=editingProduct?.sale_price??"";$("productShippingWeight").value=editingProduct?.shipping_weight_kg??"";$("productShippingHeight").value=editingProduct?.shipping_height_cm??"";$("productShippingWidth").value=editingProduct?.shipping_width_cm??"";$("productShippingLength").value=editingProduct?.shipping_length_cm??"";$("productImageFiles").value="";$("productDescription").value=editingProduct?.description||"";$("productNew").checked=!!editingProduct?.is_new;$("productSale").checked=!!editingProduct?.is_sale;$("productActive").checked=editingProduct?!!editingProduct.active:true;$("formError").textContent="";$("variantsList").innerHTML="";(editingProduct?.product_variants||[]).forEach(v=>addVariant(v));renderProductImageManager();$("productModal").classList.remove("hidden")}
function closeProduct(){$("productModal").classList.add("hidden");editingProduct=null}
function addVariant(v={}){const row=document.createElement("div");row.className="variant-row";row.dataset.id=v.id||"";row.innerHTML=`<input class="v-color" placeholder="Cor" value="${esc(v.color||"")}"><input class="v-sku" placeholder="SKU da cor" value="${esc(v.sku||"")}"><input class="v-stock" type="number" min="0" value="${Number(v.stock||0)}"><button type="button" class="remove-variant">×</button>`;row.querySelector(".remove-variant").onclick=()=>row.remove();$("variantsList").appendChild(row)}
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
     '<img src="'+esc(url)+'" onerror="this.style.opacity=\'0.2\'">'+
     '<span class="image-drag-handle" aria-hidden="true">↕</span>'+
     '<button type="button" class="image-remove" onclick="removeProductImage('+i+');event.stopPropagation()">×</button>'+
     '<span>'+(i===0?"CAPA":"FOTO "+(i+1))+'</span>'+
   '</div>';
 });
 productImageFiles.forEach((file,i)=>{
   const preview=URL.createObjectURL(file);
   html+='<div class="product-image-item pending" draggable="true" data-pending-index="'+i+'" title="Arraste para alterar a ordem">'+
     '<img src="'+preview+'" alt="">'+
     '<span class="image-drag-handle" aria-hidden="true">↕</span>'+
     '<span>AGUARDANDO UPLOAD</span>'+
     '<button type="button" class="image-remove" onclick="removePendingImage('+i+');event.stopPropagation()">×</button>'+
   '</div>';
 });
 box.innerHTML=html||'<p class="field-help">Nenhuma foto adicionada.</p>';
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
async function uploadProductImages(productId,files=productImageFiles){const urls=[];for(const file of files){validateProductImage(file);const dataUrl=await readFileAsDataUrl(file);const d=await api("/api/admin/uploads/product-image",{method:"POST",body:JSON.stringify({product_id:productId,file_name:file.name,content_type:file.type,data_base64:dataUrl})});urls.push(d.url)}return urls}
function currentProductPayload(images=productImageDraft){return{name:$("productName").value.trim(),sku:$("productSku").value.trim()||null,category:$("productCategory").value,price:Number($("productPrice").value),sale_price:$("productSalePrice").value?Number($("productSalePrice").value):null,description:$("productDescription").value.trim(),images,shipping_weight_kg:$("productShippingWeight").value?Number($("productShippingWeight").value):null,shipping_height_cm:$("productShippingHeight").value?Number($("productShippingHeight").value):null,shipping_width_cm:$("productShippingWidth").value?Number($("productShippingWidth").value):null,shipping_length_cm:$("productShippingLength").value?Number($("productShippingLength").value):null,is_new:$("productNew").checked,is_sale:$("productSale").checked,active:$("productActive").checked}}
async function persistProductImages(productId){await api("/api/admin/products/"+encodeURIComponent(productId),{method:"PUT",body:JSON.stringify(currentProductPayload(productImageDraft))})}
async function saveProduct(e){e.preventDefault();$("formError").textContent="";const id=$("productId").value;const payload=currentProductPayload(productImageDraft);if(!payload.name){$("formError").textContent="Informe o nome.";return}try{const endpoint=id?"/api/admin/products/"+encodeURIComponent(id):"/api/admin/products";const d=await api(endpoint,{method:id?"PUT":"POST",body:JSON.stringify(payload)});const pid=d.product.id;const uploaded=await uploadProductImages(pid);const images=[...productImageDraft,...uploaded];if(uploaded.length){await api("/api/admin/products/"+encodeURIComponent(pid),{method:"PUT",body:JSON.stringify({...payload,images})})}const variants=[...document.querySelectorAll(".variant-row")].map(r=>({id:r.dataset.id||null,color:r.querySelector(".v-color").value.trim(),sku:r.querySelector(".v-sku").value.trim()||null,stock:Math.max(0,Number(r.querySelector(".v-stock").value||0)),active:true})).filter(v=>v.color);await api("/api/admin/products/"+encodeURIComponent(pid)+"/variants",{method:"PUT",body:JSON.stringify({variants})});closeProduct();await loadProducts()}catch(e){$("formError").textContent=e.message}}
function money(v){return new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(v||0))}
function date(v){return v?new Date(v).toLocaleString("pt-BR"):"—"}
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}

async function sendTrackingWhatsApp(id){const errorBox=$("orderUpdateError");if(errorBox)errorBox.textContent="";try{const d=await api(`/api/admin/orders/${encodeURIComponent(id)}/tracking-whatsapp`,{method:"POST"});await loadOrders();openOrder(id);if(d.whatsapp?.status==="not_configured")alert("WhatsApp ainda não está configurado no Render.");}catch(e){if(errorBox)errorBox.textContent=e.message}}
