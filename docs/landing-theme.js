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
    const label={dark:'深色',light:'淺色',system:'自動'}[preference];
    const trigger=document.getElementById('appearance');
    if(trigger){trigger.setAttribute('aria-label',`網站外觀：${label}`);document.getElementById('appearance-label').textContent=label;}
    document.querySelectorAll('[data-appearance-option]').forEach(option=>option.setAttribute('aria-checked',String(option.dataset.appearanceOption===preference)));
    document.querySelector(`.theme-switch [data-theme="${theme}"]`)?.click();
    syncDocs(theme);
  }
  apply();
  system.addEventListener('change',()=>{if(preference==='system')apply();});
  addEventListener('storage',event=>{if(event.key==='shioaji-pro-appearance'){preference=valid(event.newValue)?event.newValue:'dark';apply();}});
  document.addEventListener('DOMContentLoaded',()=>{
    const trigger=document.getElementById('appearance'), menu=document.getElementById('appearance-menu');
    const options=[...menu.querySelectorAll('[role="menuitemradio"]')];
    const close=(restore=false)=>{menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(restore)trigger.focus();};
    const open=(index=options.findIndex(option=>option.dataset.appearanceOption===preference))=>{menu.hidden=false;trigger.setAttribute('aria-expanded','true');options[Math.max(0,index)].focus();};
    trigger.addEventListener('click',()=>menu.hidden?open():close());
    trigger.addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();open(event.key==='ArrowDown'?0:options.length-1);}});
    options.forEach(option=>option.addEventListener('click',()=>{
      preference=option.dataset.appearanceOption;
      try{localStorage.setItem('shioaji-pro-appearance',preference);}catch{}
      apply();close(true);
    }));
    menu.addEventListener('keydown',event=>{
      const index=options.indexOf(document.activeElement);
      if(event.key==='Tab'){close(true);return;}
      if(event.key==='Escape'){event.preventDefault();close(true);}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next].focus();
      }
    });
    document.addEventListener('pointerdown',event=>{if(!event.target.closest('.appearance-control'))close();});
    document.addEventListener('focusin',event=>{if(!event.target.closest('.appearance-control'))close();});
    document.addEventListener('click',event=>{
      const link=event.target.closest('a[href]');if(!link)return;
      if(new URL(link.href).origin==='https://sinotrade.github.io')syncDocs(root.dataset.appearance);
    },true);
    apply();
  });
})();
