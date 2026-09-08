// Run before CSS so a saved light preference never flashes a dark first frame.
(() => {
  const root=document.documentElement;
  const system=matchMedia('(prefers-color-scheme: dark)');
  const valid=value=>['dark','light','system'].includes(value);
  let preference='dark';
  try {const saved=localStorage.getItem('shioaji-pro-appearance');if(valid(saved))preference=saved;}catch{}
  function syncDocs(theme){
    // MkDocs Material's documented site's root scope, verified from its page bootstrap.
    // Production shares this origin; localhost cannot write another origin's storage.
    if(location.origin!=='https://sinotrade.github.io')return;
    try{localStorage.setItem('/.__palette',JSON.stringify({index:theme==='dark'?1:0,color:{media:`(prefers-color-scheme: ${theme})`,scheme:theme==='dark'?'slate':'default',primary:theme==='dark'?'black':'cyan',accent:'amber'}}));}catch{}
  }
  function apply(){
    const theme=preference==='system'?(system.matches?'dark':'light'):preference;
    root.dataset.appearance=theme;root.dataset.appearancePreference=preference;
    const select=document.getElementById('appearance');if(select)select.value=preference;
    document.querySelector(`.theme-switch [data-theme="${theme}"]`)?.click();
    syncDocs(theme);
  }
  apply();
  system.addEventListener('change',()=>{if(preference==='system')apply();});
  addEventListener('storage',event=>{if(event.key==='shioaji-pro-appearance'){preference=valid(event.newValue)?event.newValue:'dark';apply();}});
  document.addEventListener('DOMContentLoaded',()=>{
    document.getElementById('appearance').addEventListener('change',event=>{
      preference=valid(event.target.value)?event.target.value:'dark';
      try{localStorage.setItem('shioaji-pro-appearance',preference);}catch{}
      apply();
    });
    document.addEventListener('click',event=>{
      const link=event.target.closest('a[href]');if(!link)return;
      if(new URL(link.href).origin==='https://sinotrade.github.io')syncDocs(root.dataset.appearance);
    },true);
    apply();
  });
})();
