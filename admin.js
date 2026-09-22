const SUPABASE_URL="https://uvrhougaurupvkxmezwy.supabase.co";
const SUPABASE_KEY="sb_publishable_oML0grXREF2gHg7WNIxNlA_BYMV9D1V";
const db=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY);

const $=id=>document.getElementById(id);
let products=[],orders=[],editingProduct=null;

document.addEventListener("DOMContentLoaded",init);

async function init(){
  const {data:{session}}=await db.auth.getSession();
  if(session) await enterApp(session);
  db.auth.onAuthStateChange(async(_event,session)=>{
    if(session) await enterApp(session); else showLogin();
  });
  $("loginForm").addEventListener("submit",login);
  $("logoutButton").addEventListener("click",()=>db.auth.signOut());
  document.querySelectorAll(".nav-button").forEach(b=>b.onclick=()=>showSection(b.dataset.section));
  document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>showSection(b.dataset.go));
  $("newProductButton").onclick=()=>openProduct();
  $("closeModal").onclick=closeProduct;
  $("cancelProduct").onclick=closeProduct;
  $("addVariant").onclick=()=>addVariant();
  $("productForm").onsubmit=saveProduct;
  $("productSearch").oninput=renderProducts;
  $("refreshOrders").onclick=loadOrders;
}

function showLogin(){$("loginView").classList.remove("hidden");$("appView").classList.add("hidden")}
async function login(e){
  e.preventDefault();$("loginError").textContent="";
  const {data,error}=await db.auth.signInWithPassword({email:$("loginEmail").value.trim(),password:$("loginPassword").value});
  if(error){$("loginError").textContent=error.message;return}
  if(data.session) await enterApp(data.session);
}
async function enterApp(session){
  const {data:{user}}=await db.auth.getUser();
  const role=user?.app_metadata?.role;
  if(role!=="admin"){await db.auth.signOut();$("loginError").textContent="Esta conta não tem acesso administrativo.";return}
  $("loginView").classList.add("hidden");$("appView").classList.remove("hidden");$("adminEmail").textContent=user.email;
  await Promise.all([loadProducts(),loadOrders()]);
  renderDashboard();
}
function showSection(section){
  document.querySelectorAll(".section").forEach(s=>s.classList.add("hidden"));
  $(section+"Section").classList.remove("hidden");
  document.querySelectorAll(".nav-button").forEach(b=>b.classList.toggle("active",b.dataset.section===section));
  $("pageTitle").textContent={dashboard:"Visão geral",products:"Produtos",orders:"Pedidos",stock:"Estoque"}[section];
  if(section==="products")renderProducts();
  if(section==="orders")renderOrders();
  if(section==="stock")renderStock();
}
async function loadProducts(){
  const {data,error}=await db.from("products").select("*,product_variants(*)").order("created_at",{ascending:false});
  if(error){alert(error.message);return} products=data||[];renderProducts();renderStock();renderDashboard();
}
async function loadOrders(){
  const {data,error}=await db.from("orders").select("*,order_items(*)").order("created_at",{ascending:false});
  if(error){orders=[];$("ordersTable").innerHTML="<p>Não foi possível carregar os pedidos.</p>";return}
  orders=data||[];renderOrders();renderDashboard();
}
function renderDashboard(){
  $("statProducts").textContent=products.filter(p=>p.active).length;
  $("statOrders").textContent=orders.length;
  $("statPaid").textContent=orders.filter(o=>["paid","processing","shipped","delivered"].includes(o.status)).length;
  $("statLowStock").textContent=products.reduce((n,p)=>n+(p.product_variants||[]).filter(v=>v.stock<=2&&v.active).length,0);
  $("recentOrders").innerHTML=orderTable(orders.slice(0,5));
}
function renderProducts(){
  const q=($("productSearch").value||"").toLowerCase();
  const list=products.filter(p=>(p.name+" "+(p.sku||"")).toLowerCase().includes(q));
  $("productsGrid").innerHTML=list.map(p=>{
    const img=Array.isArray(p.images)&&p.images[0]?p.images[0]:"";
    const stock=(p.product_variants||[]).reduce((n,v)=>n+Number(v.stock||0),0);
    return `<article class="admin-product"><img src="${esc(img)}" onerror="this.style.visibility='hidden'"><div class="admin-product-body"><h3>${esc(p.name)}</h3><div class="meta">${esc(p.sku||"SEM SKU")} · ${money(p.sale_price||p.price)} · estoque ${stock}</div><div class="admin-product-actions"><button onclick="openProduct('${p.id}')">EDITAR</button><button class="secondary" onclick="toggleProduct('${p.id}',${!p.active})">${p.active?"DESATIVAR":"ATIVAR"}</button></div></div></article>`
  }).join("")||"<p>Nenhum produto encontrado.</p>";
}
function renderStock(){
  const rows=[];
  products.forEach(p=>(p.product_variants||[]).forEach(v=>rows.push([p.name,v.color,v.sku||p.sku||"",v.stock,v.active])));
  $("stockTable").innerHTML=`<table class="table"><thead><tr><th>PRODUTO</th><th>COR</th><th>SKU</th><th>ESTOQUE</th><th>STATUS</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td class="${r[3]<=2?"stock-low":""}">${r[3]}</td><td>${r[4]?"Ativo":"Inativo"}</td></tr>`).join("")||"<tr><td colspan='5'>Nenhuma variação cadastrada.</td></tr>"}</tbody></table>`;
}
function orderTable(list){
  if(!list.length)return "<p>Nenhum pedido encontrado.</p>";
  return `<table class="table"><thead><tr><th>PEDIDO</th><th>CLIENTE</th><th>DATA</th><th>TOTAL</th><th>STATUS</th></tr></thead><tbody>${list.map(o=>`<tr><td>${esc(o.order_nsu||"—")}</td><td>${esc(o.customer_name||"—")}</td><td>${date(o.created_at)}</td><td>${money(o.total)}</td><td><span class="badge ${esc(o.status||"pending")}">${esc(o.status||"pending")}</span></td></tr>`).join("")}</tbody></table>`;
}
function renderOrders(){$("ordersTable").innerHTML=orderTable(orders)}
function openProduct(id=null){
  editingProduct=id?products.find(p=>p.id===id):null;
  $("modalTitle").textContent=editingProduct?"Editar produto":"Novo produto";
  $("productId").value=editingProduct?.id||"";
  $("productName").value=editingProduct?.name||"";
  $("productSku").value=editingProduct?.sku||"";
  $("productCategory").value=editingProduct?.category||"bolsas";
  $("productPrice").value=editingProduct?.price??"";
  $("productSalePrice").value=editingProduct?.sale_price??"";
  $("productImage").value=editingProduct?.images?.[0]||"";
  $("productDescription").value=editingProduct?.description||"";
  $("productNew").checked=!!editingProduct?.is_new;
  $("productSale").checked=!!editingProduct?.is_sale;
  $("productActive").checked=editingProduct?!!editingProduct.active:true;
  $("formError").textContent="";
  $("variantsList").innerHTML="";
  (editingProduct?.product_variants||[]).forEach(v=>addVariant(v));
  $("productModal").classList.remove("hidden");
}
function closeProduct(){$("productModal").classList.add("hidden");editingProduct=null}
function addVariant(v={}){const row=document.createElement("div");row.className="variant-row";row.dataset.id=v.id||"";row.innerHTML=`<input class="v-color" placeholder="Cor" value="${esc(v.color||"")}"><input class="v-stock" type="number" min="0" value="${Number(v.stock||0)}"><button type="button" class="remove-variant">×</button>`;row.querySelector(".remove-variant").onclick=()=>row.remove();$("variantsList").appendChild(row)}
async function saveProduct(e){
  e.preventDefault();$("formError").textContent="";
  const id=$("productId").value;
  const images=$("productImage").value.trim()?[$("productImage").value.trim()]:[];
  const payload={name:$("productName").value.trim(),sku:$("productSku").value.trim()||null,category:$("productCategory").value,price:Number($("productPrice").value),sale_price:$("productSalePrice").value?Number($("productSalePrice").value):null,description:$("productDescription").value.trim(),images,is_new:$("productNew").checked,is_sale:$("productSale").checked,active:$("productActive").checked};
  if(!payload.name){$("formError").textContent="Informe o nome.";return}
  let productId=id;
  const result=id?await db.from("products").update(payload).eq("id",id).select().single():await db.from("products").insert(payload).select().single();
  if(result.error){$("formError").textContent=result.error.message;return}
  productId=result.data.id;
  const existing=editingProduct?.product_variants||[];
  const rows=[...document.querySelectorAll(".variant-row")];
  for(const old of existing)if(!rows.some(r=>r.dataset.id===old.id))await db.from("product_variants").delete().eq("id",old.id);
  for(const row of rows){
    const color=row.querySelector(".v-color").value.trim();if(!color)continue;
    const stock=Math.max(0,Number(row.querySelector(".v-stock").value||0));const vid=row.dataset.id;
    const data={product_id:productId,color,stock,active:true};
    const q=vid?await db.from("product_variants").update(data).eq("id",vid):await db.from("product_variants").insert(data);
    if(q.error){$("formError").textContent=q.error.message;return}
  }
  closeProduct();await loadProducts();
}
async function toggleProduct(id,active){const {error}=await db.from("products").update({active}).eq("id",id);if(error)alert(error.message);else await loadProducts()}
function money(v){return new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(v||0))}
function date(v){return v?new Date(v).toLocaleString("pt-BR"):"—"}
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}