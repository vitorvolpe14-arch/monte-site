/* =====================================================
   BANNERS DA PÁGINA INICIAL
   Carrossel do topo e banner do meio (fotos ao lado de "Mais que bolsas."):
   enviar, remover e arrastar para ordenar. Nada muda no site até SALVAR.
   As fotos do carrossel do topo vão exatamente como foram escolhidas; as do
   banner do meio são otimizadas no navegador (WebP de 2400 px e outra de
   1200 px para o celular) e vão direto para o Supabase.
===================================================== */
function bannerManager(o){
  let draft=[];
  let bound=false;

  function setStatus(message="",error=false){
    const el=$(o.ids.status);
    if(el){el.textContent=message;el.classList.toggle("error",!!error)}
  }

  function render(){
    const box=$(o.ids.manager);
    if(!box)return;
    setHTML(box, draft.map((url,i)=>
      '<div class="product-image-item carousel-image-item" draggable="true" data-index="'+i+'">'+
        '<img src="'+esc(url)+'" alt="'+esc(o.alt)+' '+(i+1)+'" data-img-error="dim">'+
        '<button type="button" class="image-remove" data-remove-banner="'+i+'">×</button>'+
        '<span>'+(i===0?"CAPA":"FOTO "+(i+1))+'</span>'+
        '<span class="carousel-drag-handle">↕</span>'+
      '</div>'
    ).join("") || '<p class="field-help">Nenhuma foto adicionada.</p>');

    box.querySelectorAll("[data-remove-banner]").forEach(btn=>{
      btn.addEventListener("click",e=>{
        e.stopPropagation();
        draft.splice(Number(btn.dataset.removeBanner),1);
        render();
        setStatus("Foto removida. Clique em "+o.saveLabel+" para confirmar.");
      });
    });

    let draggingIndex=null;
    box.querySelectorAll(".carousel-image-item").forEach(item=>{
      item.addEventListener("dragstart",()=>{
        draggingIndex=Number(item.dataset.index);
        item.classList.add("is-dragging");
      });
      item.addEventListener("dragend",()=>{
        draggingIndex=null;
        item.classList.remove("is-dragging");
        box.querySelectorAll(".drag-over").forEach(x=>x.classList.remove("drag-over"));
      });
      item.addEventListener("dragover",e=>{
        e.preventDefault();
        item.classList.add("drag-over");
      });
      item.addEventListener("dragleave",()=>item.classList.remove("drag-over"));
      item.addEventListener("drop",e=>{
        e.preventDefault();
        item.classList.remove("drag-over");
        const targetIndex=Number(item.dataset.index);
        if(draggingIndex===null||draggingIndex===targetIndex)return;
        const [moved]=draft.splice(draggingIndex,1);
        draft.splice(targetIndex,0,moved);
        render();
        setStatus("Ordem alterada. Clique em "+o.saveLabel+" para confirmar.");
      });
    });
  }

  async function handleFiles(files){
    if(!files.length)return;
    try{
      files.forEach(validateProductImage);
      setStatus(o.sendingMessage);
      const {urls,notes}=await o.upload(files);
      draft.push(...urls);
      render();
      setStatus([urls.length+" foto(s) adicionada(s). Clique em "+o.saveLabel+" para publicar.",...(notes||[])].join(" "));
    }catch(e){
      setStatus(e.message,true);
    }
  }

  async function save(){
    const button=$(o.ids.save);
    if(button)button.disabled=true;
    try{
      const d=await api(o.api,{method:"PUT",body:JSON.stringify({images:draft})});
      draft=Array.isArray(d.images)?d.images:draft;
      render();
      setStatus(o.savedMessage);
      if(o.afterSave)o.afterSave(d);
    }catch(e){
      setStatus(e.message,true);
    }finally{
      if(button)button.disabled=false;
    }
  }

  function bind(){
    if(bound)return;
    const zone=$(o.ids.dropzone);
    const input=$(o.ids.files);
    const button=$(o.ids.select);
    const saveButton=$(o.ids.save);
    if(!zone||!input)return;
    bound=true;

    if(saveButton)saveButton.onclick=save;

    if(button){
      button.onclick=e=>{
        e.preventDefault();
        e.stopPropagation();
        input.click();
      };
    }

    zone.onclick=e=>{
      if(e.target!==input&&e.target!==button)input.click();
    };

    zone.onkeydown=e=>{
      if(e.key==="Enter"||e.key===" "){
        e.preventDefault();
        input.click();
      }
    };

    input.onchange=async e=>{
      await handleFiles([...e.target.files]);
      input.value="";
    };

    ["dragenter","dragover"].forEach(type=>{
      zone.addEventListener(type,e=>{
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add("drag-over");
      });
    });

    ["dragleave","drop"].forEach(type=>{
      zone.addEventListener(type,e=>{
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove("drag-over");
      });
    });

    zone.addEventListener("drop",async e=>{
      await handleFiles([...e.dataTransfer.files]);
    });
  }

  return {
    async load(){
      bind();
      try{
        const d=await api(o.api);
        draft=Array.isArray(d.images)?d.images:[];
        render();
        setStatus(o.loadedMessage?o.loadedMessage(d):"");
        if(o.afterLoad)o.afterLoad(d);
      }catch(e){setStatus(e.message,true)}
    }
  };
}

// Carrossel do topo: as fotos vão exatamente como foram escolhidas (sem conversão).
async function uploadCarouselImages(files){
  const urls=[];
  for(const file of files){
    const dataUrl=await readFileAsDataUrl(file);
    const d=await api("/api/admin/uploads/carousel-image",{
      method:"POST",
      body:JSON.stringify({
        file_name:file.name,
        content_type:file.type,
        data_base64:dataUrl
      })
    });
    urls.push(d.url);
  }
  return {urls};
}

// Prévia do link da loja (WhatsApp, Instagram): a primeira foto do carrossel em JPEG leve de
// 1200 × 630, feita aqui no navegador quando a primeira foto muda (ou ainda não tem prévia).
// Sem ela, o site usa a primeira foto como está, que pode ser pesada demais para o WhatsApp.
const SHARE_W=1200,SHARE_H=630,SHARE_MAX_BYTES=280*1024;
let carouselShareJob="";
async function carouselShareJpeg(url){
  const image=await loadImageSource(await fetchPhotoBlob(url));
  const w=image.naturalWidth||image.width,h=image.naturalHeight||image.height;
  const canvas=document.createElement("canvas");canvas.width=SHARE_W;canvas.height=SHARE_H;
  const ctx=canvas.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,SHARE_W,SHARE_H);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
  // Preenche 1200 × 630 sem deformar (corta as bordas que sobrarem, centralizado).
  const scale=Math.max(SHARE_W/w,SHARE_H/h),dw=w*scale,dh=h*scale;
  ctx.drawImage(image,(SHARE_W-dw)/2,(SHARE_H-dh)/2,dw,dh);
  if(typeof image.close==="function")image.close();
  for(const quality of [.86,.78,.7,.6]){
    const blob=await canvasBlob(canvas,"image/jpeg",quality);
    if(blob&&blob.type==="image/jpeg"&&blob.size<=SHARE_MAX_BYTES)return blob;
  }
  throw new Error("a prévia ficou grande demais");
}
async function ensureCarouselShare(d){
  const first=Array.isArray(d?.images)?d.images[0]:"";
  if(!first||d?.share?.source===first||carouselShareJob===first)return;
  carouselShareJob=first;
  try{
    const blob=await carouselShareJpeg(first);
    await api("/api/admin/uploads/carousel-share",{method:"POST",body:JSON.stringify({source:first,data_base64:await readFileAsDataUrl(blob)})});
  }catch(e){console.warn("Prévia do link da loja não foi feita:",e.message)}
  finally{if(carouselShareJob===first)carouselShareJob=""}
}
// Ao entrar no painel: faz a prévia se ainda não existe (por exemplo, carrossel salvo antes).
window.ensureCarouselSharePreview=async function(){try{await ensureCarouselShare(await api("/api/admin/carousel"))}catch{}};

// Banner do meio: o espaço no site é 2:1; foto em outra proporção tem as bordas cortadas.
async function uploadEditorialImages(files){
  const urls=[],notes=[];
  for(const file of files){
    const photo=await uploadOptimizedPhoto(file,"banner");
    urls.push(photo.url);
    const ratio=photo.width/photo.height;
    if(ratio&&Math.abs(ratio-2)>.15)notes.push("Atenção: "+file.name+" não está na proporção 2:1 ("+photo.width+" × "+photo.height+"); no site as bordas dessa foto serão cortadas.");
  }
  return {urls,notes};
}

const homeCarouselManager=bannerManager({
  api:"/api/admin/carousel",
  ids:{dropzone:"carouselImageDropzone",files:"carouselImageFiles",select:"selectCarouselPhotosButton",save:"saveCarouselButton",status:"carouselImageStatus",manager:"carouselImageManager"},
  alt:"Carrossel",
  saveLabel:"SALVAR CARROSSEL",
  sendingMessage:"Enviando foto(s)...",
  savedMessage:"Carrossel salvo com sucesso.",
  upload:uploadCarouselImages,
  afterLoad:ensureCarouselShare,
  afterSave:ensureCarouselShare
});

const editorialBannerManager=bannerManager({
  api:"/api/admin/editorial",
  ids:{dropzone:"editorialImageDropzone",files:"editorialImageFiles",select:"selectEditorialPhotosButton",save:"saveEditorialButton",status:"editorialImageStatus",manager:"editorialImageManager"},
  alt:"Banner do meio",
  saveLabel:"SALVAR BANNER DO MEIO",
  sendingMessage:"Otimizando e enviando foto(s)...",
  savedMessage:"Banner do meio salvo. Em até 1 minuto ele aparece no site.",
  loadedMessage:d=>d.custom?"":"Estas são as fotos que estão no site agora (Bordeaux Collection).",
  upload:uploadEditorialImages
});

window.loadCarousel=function loadCarousel(){
  homeCarouselManager.load();
  editorialBannerManager.load();
};
