const songs = [
 ['Take My Hand','Jeremy Dutcher','CCdsX4mrNVA','Open hands','Where have you felt invited to trust?'],
 ['Nearer My God to Thee','The Lower Lights','PeN9ljKvrY4','Draw near','What helps you feel close to God?'],
 ['Turn Your Eyes Upon Jesus','Lauren Daigle','L57ox0iQU7A','A renewed gaze','Where are you turning your attention today?'],
 ['Give Me Rest','The Gray Havens','BNqbf1BU6SU','Letting go','What are you ready to place in God’s hands?'],
 ['Rest','Michael Kiwanuka','9X-aCebgZPg','Be still','What would it mean to receive rest today?'],
 ['Morning Light','Josh Garrels','azDh0l3gjQI','Light returns','Where have you noticed a new beginning?'],
 ['Full Circle','AHI','9wdSj3My68Y','Coming home','What has this year taught you about belonging?'],
 ['Farther Along','Josh Garrels','EWBGcNb9F5c','Keep walking','What hope helps you take the next step?'],
 ['Blessings','Hollow Coves','KY7rwjFmNfs','Everyday gifts','Which ordinary blessing do you want to remember?'],
 ['Thank God I Do','Lauren Daigle','dHyxWLsWbNk','Held in love','Who has helped you recognize God’s love?'],
 ['Glorious','MaMuse','D75010fQY-0','Wonder all around','What beauty have you noticed around you today?'],
 ['Thankful','Forrest Frank','VOZbswniA-g','A grateful heart','What will you carry with gratitude from our time together?']
];
let current = 0;
const $ = id => document.getElementById(id);
const number = i => String(i + 1).padStart(2,'0');
const tracks = $('tracks');
songs.forEach((song,i) => {
 const li = document.createElement('li');
 const button = document.createElement('button');
 button.innerHTML = `<span class="track-number">${number(i)}</span><span><span class="track-title">${song[0]}</span><span class="track-artist">${song[1]}</span></span><span class="track-play" aria-hidden="true">▷</span>`;
 button.setAttribute('aria-label',`Listen to ${song[0]} by ${song[1]}`);
 button.onclick = () => {select(i);$('listening').scrollIntoView({behavior:'smooth'});$('song-title').focus({preventScroll:true});};
 li.append(button);tracks.append(li);
 const dot = document.createElement('button');dot.innerHTML='<span></span>';dot.setAttribute('aria-label',`Song ${i+1}: ${song[0]}`);dot.onclick=()=>select(i);$('dots').append(dot);
});
function loadPlayer(){
 const frame=document.createElement('iframe');
 frame.src=`https://www.youtube-nocookie.com/embed/${songs[current][2]}?autoplay=1&rel=0&playsinline=1`;
 frame.title=`Official audio: ${songs[current][0]} — ${songs[current][1]}`;
 frame.allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
 frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';
 $('player-wrap').replaceChildren(frame);
}
function select(i){
 current=Math.max(0,Math.min(songs.length-1,i));const song=songs[current];
 $('chapter').textContent=`${number(current)} / 12`;$('theme').textContent=song[3].toUpperCase();
 $('song-title').textContent=song[0];$('artist').textContent=song[1];$('prompt').textContent=song[4];
 $('external').href=`https://www.youtube.com/watch?v=${song[2]}`;
 $('previous').disabled=current===0;$('next').disabled=current===songs.length-1;
 $('player-wrap').innerHTML='<button id="load-player" class="load-player"><span class="play-circle" aria-hidden="true">▶</span><span>Listen to this song</span><small>Official audio · YouTube</small></button>';
 $('load-player').onclick=loadPlayer;
 [...tracks.children].forEach((li,j)=>li.firstChild.setAttribute('aria-current',String(j===current)));
 [...$('dots').children].forEach((dot,j)=>dot.setAttribute('aria-current',String(j===current)));
}
$('previous').onclick=()=>select(current-1);$('next').onclick=()=>select(current+1);
$('present').onclick=()=>{const on=document.body.classList.toggle('presenting');$('present').setAttribute('aria-pressed',String(on));$('present').innerHTML=on?'Exit presentation <span aria-hidden="true">⛶</span>':'Presentation mode <span aria-hidden="true">⛶</span>';window.scrollTo({top:0,behavior:'smooth'});};
document.addEventListener('keydown',event=>{if(!document.body.classList.contains('presenting')||event.altKey||event.ctrlKey||event.metaKey)return;if(event.key==='ArrowRight'){event.preventDefault();select(current+1);}if(event.key==='ArrowLeft'){event.preventDefault();select(current-1);}if(event.key==='Escape')$('present').click();});
select(0);
