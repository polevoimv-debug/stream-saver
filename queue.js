const rows = new Map();
const list = document.querySelector('#jobs');
async function send(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({target:'engine', type, ...fields});
  if (!result || result.error) throw Error(result?.error || 'Фоновая очередь недоступна.');
  return result.value;
}

let revision = -1;
function render(snapshot) {
  if (snapshot.revision < revision) return;
  revision = snapshot.revision;
  const jobs = snapshot.jobs;
  document.querySelector('#notice').textContent = snapshot.notice;
  const ids = new Set(jobs.map(j => j.id));
  for (const [id, row] of rows) {
    if (!ids.has(id)) { row.remove(); rows.delete(id); }
  }
  document.querySelector('#empty').hidden = jobs.length > 0;
  for (const [index, job] of jobs.entries()) {
    let row = rows.get(job.id);
    if (!row) {
      row = document.createElement('li');
      row.innerHTML = '<strong></strong><p></p><progress max="100"></progress><br><button></button> <button>В очередь</button> <button>Отменить</button> <button>Удалить задачу и файл</button>';
      rows.set(job.id,row);
      list.append(row);
    }
    const [name,status,bar,,pause,defer,cancel,remove] = row.children;
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    name.textContent = job.name + ' · ' + job.detail;
    status.textContent = (job.state === 'paused' ? 'Приостановлено · ' : job.state === 'waiting' ? 'В очереди · ' : '') + job.text;
    if (job.percent == null) bar.removeAttribute('value'); else bar.value = job.percent;
    pause.textContent = job.state === 'waiting' ? 'Скачать сейчас' : job.state === 'paused' ? 'Продолжить' : 'Пауза';
    pause.disabled = !['waiting','active','paused'].includes(job.state);
    defer.disabled = !['active','paused'].includes(job.state);
    cancel.disabled = !['waiting','active','paused'].includes(job.state);
    const act = type => send(type,{id:job.id}).catch(e => {status.textContent = e.message;});
    pause.onclick = () => act(job.state === 'active' ? 'pause' : 'resume');
    defer.onclick = () => act('defer');
    cancel.onclick = () => act('cancel');
    remove.disabled = job.state === 'deleting';
    remove.onclick = () => act('delete');
  }
}
const channel = new BroadcastChannel('stream-saver-queue');
channel.onmessage = e => render(e.data);
export async function connect() {
  const result = await chrome.runtime.sendMessage({target:'broker',type:'ensure'});
  if (result?.error) throw Error(result.error);
  render(await send('list'));
}
export async function enqueue(media,name,detail,deferred) {
  await send('add',{media,name,detail,deferred,id:crypto.randomUUID()});
}
