// Presentation-only animations. No network, broker connection, or order actions.
(() => {
  const stage = document.querySelector('.demo-shelf');
  const book = document.getElementById('demo-book');
  const consoleBox = document.getElementById('demo-console');
  const canvas = document.getElementById('market-spark');
  if (!stage || !book || !consoleBox || !canvas) return;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const context = canvas.getContext('2d');
  const rowCount = 4;
  const rows = [];
  for (let side = 0; side < 2; side++) {
    if (side === 1) {
      const middle = document.createElement('div');
      middle.className = 'book-mid'; middle.textContent = '44,525'; book.append(middle);
    }
    for (let i = 0; i < rowCount; i++) {
      const row = document.createElement('div'); row.className = `book-row${side === 0 ? ' ask' : ''}`;
      const bid = document.createElement('span'), price = document.createElement('span'), ask = document.createElement('span');
      price.className = 'book-price'; price.textContent = (44525 + (side === 0 ? rowCount - i : -i - 1)).toLocaleString('en-US');
      const bar = document.createElement('i'), amount = document.createElement('b');
      (side === 0 ? ask : bid).append(bar, amount);
      row.append(bid, price, ask); book.append(row);
      rows.push({ bar, amount, volume: 20 + i * 17 + side * 8 });
    }
  }
  const script = [
    ['user', '建立 20／60 均線交叉策略，參數可調整。'],
    ['tool', '原生策略 → 建立規則 → 驗證輸出'],
    ['done', '策略已建立，可在回測面板驗證。'],
    ['user', '讀取最新回測，列出成本與交易明細。'],
    ['tool', '回測結果 → 成本假設 → 交易明細'],
    ['done', '結果已讀取，接著比較各商品表現。'],
  ];
  let scriptIndex = 0, character = 0, consoleElapsed = 0, pause = 0;
  let lines = [];
  function renderConsole(typing) {
    consoleBox.replaceChildren();
    lines.slice(-3).forEach(([type, text], index, visibleLines) => {
      const line = document.createElement('div'); line.className = `console-line ${type}`; line.textContent = text;
      if (typing && index === visibleLines.length - 1) {
        const caret = document.createElement('span'); caret.className = 'console-caret'; line.append(caret);
      }
      consoleBox.append(line);
    });
  }
  function typeStep() {
    if (pause > 0) { pause--; return; }
    const entry = script[scriptIndex % script.length];
    if (character === 0) {
      if (scriptIndex % script.length === 0) lines = [];
      lines.push([entry[0], '']);
    }
    character++; lines[lines.length - 1][1] = entry[1].slice(0, character);
    renderConsole(character < entry[1].length);
    if (character >= entry[1].length) { character = 0; scriptIndex++; pause = entry[0] === 'done' ? 38 : 16; }
  }
  const points = Array.from({ length: 75 }, (_, i) => .55 + Math.sin(i * .07) * .16 + Math.sin(i * .31) * .08);
  let value = points.at(-1), velocity = .005;
  function updateBook() {
    rows.forEach((row, index) => {
      row.volume = Math.max(5, Math.min(160, row.volume + Math.sin(ticks * .8 + index * 2.4) * 24));
      row.bar.style.width = `${row.volume / 1.7}%`;
      row.amount.textContent = String(Math.round(row.volume));
    });
  }
  let chartWidth = 0, chartHeight = 0;
  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    chartWidth = canvas.clientWidth; chartHeight = canvas.clientHeight;
    canvas.width = chartWidth * dpr; canvas.height = chartHeight * dpr;
    if (context) context.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSpark();
  }
  function drawSpark() {
    if (!context || !chartWidth) return;
    context.clearRect(0, 0, chartWidth, chartHeight);
    context.strokeStyle = '#7289a315'; context.lineWidth = .5;
    for (let i = 1; i < 4; i++) { const y = chartHeight * i / 4; context.beginPath(); context.moveTo(12,y); context.lineTo(chartWidth-12,y); context.stroke(); }
    context.beginPath();
    points.forEach((point,i) => {
      const x=12+i/(points.length-1)*(chartWidth-24), y=12+point*(chartHeight-24);
      if(i) context.lineTo(x,y); else context.moveTo(x,y);
    });
    context.lineWidth=1.4; context.strokeStyle='#bc7c89'; context.shadowColor='#bc7c8980'; context.shadowBlur=8; context.stroke(); context.shadowBlur=0;
    const y=12+points.at(-1)*(chartHeight-24);
    context.lineTo(chartWidth-12,chartHeight);context.lineTo(12,chartHeight);context.closePath();
    const fill=context.createLinearGradient(0,0,0,chartHeight);fill.addColorStop(0,'#aa617a33');fill.addColorStop(1,'#aa617a00');context.fillStyle=fill;context.fill();
    context.beginPath();context.arc(chartWidth-12,y,2,0,Math.PI*2);context.fillStyle='#efb4c1';context.fill();
  }
  let frame=0,last=0,elapsed=0,ticks=0,visible=true;
  function animate(time) {
    frame=0;
    if(document.hidden || !visible || motion.matches) return;
    const delta=Math.min(80,time-last||16);last=time;elapsed+=delta;consoleElapsed+=delta;
    if(elapsed>480) {
      elapsed=0;ticks++;updateBook();
      velocity=velocity*.8+Math.sin(ticks*.7)*.014;
      value=Math.max(.16,Math.min(.83,value+velocity));points.push(value);points.shift();drawSpark();
    }
    if(consoleElapsed>34) {consoleElapsed=0;typeStep();}
    frame=requestAnimationFrame(animate);
  }
  function sync() {
    cancelAnimationFrame(frame);frame=0;last=0;
    stage.classList.toggle('scene-paused',document.hidden||!visible||motion.matches);
    if(motion.matches) {lines=script.slice(0,3).map(entry=>[...entry]);renderConsole(false);drawSpark();}
    else if(visible&&!document.hidden) frame=requestAnimationFrame(animate);
  }
  updateBook();size();
  if('IntersectionObserver' in window) new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;sync();}).observe(stage);
  motion.addEventListener('change',()=>{scriptIndex=0;character=0;pause=0;consoleElapsed=0;lines=[];sync();});document.addEventListener('visibilitychange',sync);addEventListener('resize',size,{passive:true});sync();
})();
