let carouselImagesDraft=[];

window.loadCarousel=async function loadCarousel(){
  try{
    const d=await api("/api/admin/carousel");
    carouselImagesDraft=Array.isArray(d.images)?d.images:[];
    renderCarouselImageManager();
    setCarouselStatus("");
  }catch(e){setCarouselStatus(e.message,true)}
}
function setCarouselStatus(message="",error=false){
  const el=$("carouselImageStatus");
  if(el){el.textContent=message;el.classList.toggle("error",!!error)}
}
function renderCarouselImageManager(){
  const box=$("carouselImageManager");
  if(!box)return;
  box.innerHTML=carouselImagesDraft.map((url,i)=>
    '<div class="product-image-item carousel-image-item" draggable="true" data-index="'+i+'">'+
      '<img src="'+esc(url)+'" alt="Carrossel '+(i+1)+'" onerror="this.style.opacity=\\'0.2\\'">'+
      '<button type="button" class="image-remove" data-remove-carousel="'+i+'">×</button>'+
      '<span>'+(i===0?"CAPA":"FOTO "+(i+1))+'</span>'+
      '<span class="carousel-drag-handle">↕</span>'+
    '</div>'
  ).join("") || '<p class="field-help">Nenhuma foto adicionada.</p>';
  box.querySelectorAll("[data-remove-carousel]").forEach(btn=>{
    btn.addEventListener("click",e=>{
      e.stopPropagation();
      carouselImagesDraft.splice(Number(btn.dataset.removeCarousel),1);
      renderCarouselImageManager();
      setCarouselStatus("Foto removida. Clique em SALVAR CARROSSEL para confirmar.");
    });
  });
  let draggingIndex=null;
  box.querySelectorAll(".carousel-image-item").forEach(item=>{
    item.addEventListener("dragstart",()=>{draggingIndex=Number(item.dataset.index);item.classList.add("is-dragging")});
    item.addEventListener("dragend",()=>{draggingIndex=null;item.classList.remove("is-dragging");box.querySelectorAll(".drag-over").forEach(x=>x.classList.remove("drag-over"))});
    item.addEventListener("dragover",e=>{e.preventDefault();item.classList.add("drag-over")});
    item.addEventListener("dragleave",()=>item.classList.remove("drag-over"));
    item.addEventListener("drop",e=>{
      e.preventDefault();item.classList.remove("drag-over");
      const targetIndex=Number(item.dataset.index);
      if(draggingIndex===null||draggingIndex===targetIndex)return;
      const [moved]=carouselImagesDraft.splice(draggingIndex,1);
      carouselImagesDraft.splice(targetIndex,0,moved);
      renderCarouselImageManager();
      setCarouselStatus("Ordem alterada. Clique em SALVAR CARROSSEL para confirmar.");
    });
  });
}
function validateCarouselImage(file){validateProductImage(file)}
async function uploadCarouselImages(files){
  const urls=[];
  for(const file of files){
    validateCarouselImage(file);
    const dataUrl=await readFileAsDataUrl(file);
    const d=await api("/api/admin/uploads/carousel-image",{method:"POST",body:JSON.stringify({file_name:file.name,content_type:file.type,data_base64:dataUrl})});
    urls.push(d.url);
  }
  return urls;
}
function bindCarouselImageDropzone(){
  const zone=$("carouselImageDropzone"),input=$("carouselImageFiles");
  if(!zone||!input)return;
  zone.onclick=e=>{if(e.target!==input)input.click()};
  zone.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();input.click()}};
  input.onchange=async e=>{await handleCarouselFiles([...e.target.files]);input.value=""};
  ["dragenter","dragover"].forEach(type=>zone.addEventListener(type,e=>{e.preventDefault();e.stopPropagation();zone.classList.add("drag-over")}));
  ["dragleave","drop"].forEach(type=>zone.addEventListener(type,e=>{e.preventDefault();e.stopPropagation();zone.classList.remove("drag-over")}));
  zone.addEventListener("drop",async e=>{await handleCarouselFiles([...e.dataTransfer.files])});
}
async function handleCarouselFiles(files){
  if(!files.length)return;
  try{
    files.forEach(validateCarouselImage);
    setCarouselStatus("Enviando foto(s)...");
    const uploaded=await uploadCarouselImages(files);
    carouselImagesDraft.push(...uploaded);
    renderCarouselImageManager();
    setCarouselStatus(uploaded.length+" foto(s) adicionada(s). Clique em SALVAR CARROSSEL para publicar.");
  }catch(e){setCarouselStatus(e.message,true)}
}
async function saveCarousel(){
  const button=$("saveCarouselButton");
  if(button)button.disabled=true;
  try{
    const d=await api("/api/admin/carousel",{method:"PUT",body:JSON.stringify({images:carouselImagesDraft})});
    carouselImagesDraft=Array.isArray(d.images)?d.images:carouselImagesDraft;
    renderCarouselImageManager();
    setCarouselStatus("Carrossel salvo com sucesso.");
  }catch(e){setCarouselStatus(e.message,true)}
  finally{if(button)button.disabled=false}
}

