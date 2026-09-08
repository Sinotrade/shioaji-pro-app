// A single physical stage: native scroll turns each product view into the next.
(() => {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const sources = [...document.querySelectorAll('[data-story], #execution, #strategy, #agent')];
  if (!sources.length) return;
  const names = ['工作區','市場脈動','產業全景','盤中雷達','走勢牆','價格階梯','組合到價監控','多帳戶','AI 策略','AI Agent'];
  const stream = document.createElement('div'); stream.className = 'feature-stream';
  const stage = document.createElement('div'); stage.className = 'stream-stage';
  const deck = document.createElement('div'); deck.className = 'stream-deck';
  const nav = document.createElement('nav'); nav.className = 'stream-nav'; nav.setAttribute('aria-label','功能展示');
  const counter = document.createElement('div'); counter.className = 'stream-counter'; counter.setAttribute('aria-hidden','true');
  stage.append(counter, deck, nav); stream.append(stage); sources[0].before(stream);
  const slides = sources.map((source,index) => {
    const id = source.id;
    const marker = document.createElement('div'); marker.className='stream-marker'; marker.dataset.anchor=id; stream.append(marker);
    const slide = document.createElement('article'); slide.className='stream-slide'; slide.dataset.feature=id;
    const copy = document.createElement('div'); copy.className='stream-copy';
    const label = document.createElement('span'); label.className='stream-label'; label.textContent=`${String(index+1).padStart(2,'0')} / ${names[index]}`;
    copy.append(label,source.querySelector('h2').cloneNode(true));
    const description=source.querySelector('.story-copy>p') || source.querySelector('.section-intro>p, .section-intro>div>p');
    if(description) copy.append(description.cloneNode(true));
    const list=source.querySelector('.story-copy ul'); if(list) copy.append(list.cloneNode(true));
    if(id==='strategy') { const p=document.createElement('p'); p.className='stream-detail'; p.textContent='描述想法 → AI 建立指標與策略 → 在回測面板驗證 → AI 解讀結果'; copy.append(p); }
    if(id==='agent') { const p=document.createElement('p'); p.className='stream-detail'; p.textContent='保存與分支對話 · 技能與背景任務 · 原生指標與策略建立 · 回測結果查詢';copy.append(p); }
    const media = document.createElement('div'); media.className='stream-media';
    source.querySelectorAll('.story-scene>figure, .execution-gallery>figure, .research-gallery>figure, .agent-visual>figure').forEach(figure => media.append(figure.cloneNode(true)));
    media.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id'));
    media.querySelectorAll('img').forEach(img=>{img.loading='eager';});
    slide.append(copy,media);deck.append(slide);
    const button=document.createElement('button');button.type='button';button.textContent=names[index];button.addEventListener('click',()=>marker.scrollIntoView({behavior:'smooth'}));nav.append(button);
    return {source,id,marker,slide,button};
  });
  let frame=0, enabled=false, step=0, active=-1;
  function layout() {
    const oldTop=stream.getBoundingClientRect().top;
    const position=enabled && step ? Math.max(0,Math.min(slides.length-1,-oldTop/step)) : null;
    const preserve=enabled && oldTop<=0 && -oldTop<=step*(slides.length-1);
    enabled=!motion.matches && innerHeight>=650;
    document.body.classList.toggle('stream-enabled',enabled);stream.hidden=!enabled;
    step=Math.round(innerHeight*.95);
    stream.style.height=`${step*(slides.length-1)+innerHeight}px`;
    slides.forEach(({source,id,marker},i)=>{source.hidden=enabled;source.id=enabled?`${id}-source`:id;marker.id=enabled?id:'';marker.style.top=`${step*i}px`;});
    if(preserve) {
      const target=enabled ? scrollY+stream.getBoundingClientRect().top+position*step : scrollY+slides[Math.round(position)].source.getBoundingClientRect().top-95;
      window.scrollTo({top:target,behavior:'instant'});
    }
    schedule();
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(render);}
  function render(){
    frame=0;if(!enabled)return;
    const position=Math.max(0,Math.min(slides.length-1,-stream.getBoundingClientRect().top/step));
    const base=Math.floor(position), fraction=position-base;
    // A readable resting interval, then a full depth rotation into the next face.
    const t=Math.max(0,Math.min(1,(fraction-.35)/.65));const eased=t*t*(3-2*t);
    const next=base+(eased>=.5?1:0);
    slides.forEach(({slide,button},i)=>{
      const distance=i-base-eased;const visible=Math.abs(distance)<1;
      slide.style.visibility=visible?'visible':'hidden';
      slide.style.opacity=String(visible?Math.pow(1-Math.abs(distance),.6):0);
      slide.style.transform=`translate3d(${distance*52}%,0,${-Math.abs(distance)*380}px) rotateY(${distance*-72}deg)`;
      slide.inert=i!==next;slide.setAttribute('aria-hidden',String(i!==next));button.setAttribute('aria-current',i===next?'step':'false');
    });
    counter.textContent=`${String(next+1).padStart(2,'0')} — ${String(slides.length).padStart(2,'0')}`;
    stage.style.setProperty('--stream-turn',`${eased*180}deg`);
    if(active!==next){active=next;const button=slides[next].button;nav.scrollTo({left:button.offsetLeft-nav.clientWidth/2+button.offsetWidth/2,behavior:'instant'});}
  }
  addEventListener('scroll',schedule,{passive:true});addEventListener('resize',layout,{passive:true});motion.addEventListener('change',layout);layout();
  if(location.hash){requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView());}
})();
