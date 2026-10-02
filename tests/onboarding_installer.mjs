// Actual GUI-generated pinned installer against an owned loopback TLS server.
// Dedicated schema in agentlink_test only; --check and fake CLI tripwires ensure
// no model/provider execution. Uses explicit operator runtime and public CA.
import {readFile, writeFile, mkdtemp, mkdir, copyFile, rm, open, lstat, readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import net from 'node:net';
import https from 'node:https';
import vm from 'node:vm';
import {runtimeDir, certificateFile} from '../scripts/operator-config.mjs';

process.umask(0o077);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = runtimeDir(), caPath = certificateFile();
const run = `installer-${randomUUID().slice(0, 8)}`;
const schema = `onboarding_installer_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ids = Object.fromEntries(['owner','peer','project','channel','private','install','wrongpin','collision','notty','lost'].map(name => [name, `${run}-${name}`]));
const report = {run, schema, database: 'agentlink_test', started_at: new Date().toISOString(), cases: [], assets: {}, models_started: 0,
  scope: 'Owned isolated schema and loopback TLS; exact GUI pipeline, no provider execution'};
const keys = {}, secrets = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
let directory, scratch, base, ca, pgEnv, sourceDSNHash, ownerKeyPath, childSerial = 0;
let server, serverLog, schemaCreated = false;
let fixtureEnv;
function safeError(error) { let value = String(error?.message || error); for (const key of secrets) value = value.replaceAll(key, '[REDACTED]'); return value.slice(0,350); }
async function check(name, action) {
  const started = performance.now();
  try { await action(); report.cases.push({name, passed:true, ms:Math.round(performance.now()-started)}); }
  catch(error) { report.cases.push({name, passed:false, error:safeError(error)}); throw error; }
  finally { console.log(JSON.stringify(report.cases.at(-1))); }
}
async function privateRead(path) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077), 'Expected private regular fixture file');
  return readFile(path);
}
async function command(binary, args, label, options = {}) {
  const {env = process.env, input, timeout = 45000} = options;
  const index = ++childSerial;
  const result = await new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, {cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
    const stdout = [], stderr = []; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout);
    child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
    child.once('error', () => { clearTimeout(timer); reject(new Error(`Fixture command unavailable: ${label}`)); });
    child.once('close', code => { clearTimeout(timer); resolveCommand({code, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)}); });
    child.stdin.end(input);
  });
  await writeFile(`${directory}/${index}-${label}.private.stdout`, result.stdout, {mode: 0o600, flag: 'wx'});
  await writeFile(`${directory}/${index}-${label}.private.stderr`, result.stderr, {mode: 0o600, flag: 'wx'});
  assert(!result.timedOut, `Fixture command timed out: ${label}`);
  if (options.expectedFailure) { assert(result.code !== 0, `Expected refusal: ${label}`); return result; }
  assert(result.code === 0, `Fixture command failed: ${label}`); return result.stdout;
}
function sql(statement, label) {
  assert(/^onboarding_installer_[a-f0-9]{16}$/.test(schema), 'Owned schema name invalid');
  return command(`${runtime}/pgsql/usr/lib/postgresql/14/bin/psql`, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], label, {env: pgEnv, input: statement, timeout: 20000});
}
async function isolatedServer() {
  directory = await mkdtemp(`${runtime}/evidence/onboarding-installer-`);
  scratch = await mkdtemp(join(tmpdir(), 'agentlink-onboarding-installer-'));
  const source = await privateRead(`${runtime}/secrets/agentlink_test-dsn`); sourceDSNHash = hash(source);
  const url = new URL(source.toString('utf8').trim());
  assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && decodeURIComponent(url.pathname) === '/agentlink_test', 'Only loopback agentlink_test is allowed');
  assert(!url.searchParams.has('host') && !url.searchParams.has('port'), 'Ambiguous database endpoint');
  pgEnv = {...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: 'agentlink_test',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: url.searchParams.get('sslmode') || 'prefer',
    PGCONNECT_TIMEOUT: '5', LD_LIBRARY_PATH: `${runtime}/pgsql/usr/lib/x86_64-linux-gnu`};
  delete pgEnv.PGOPTIONS;
  assert((await sql('SELECT current_database();', 'database-boundary')).toString().trim() === 'agentlink_test', 'Wrong database');
  await sql(`CREATE SCHEMA "${schema}";`, 'create-owned-schema'); schemaCreated = true;
  url.searchParams.set('search_path', schema);
  const dsnPath = `${scratch}/database.private`; await writeFile(dsnPath, url.toString() + '\n', {mode: 0o600, flag: 'wx'});
  const binary = `${scratch}/agent-link`; await command('go', ['build', '-o', binary, './cmd/agent-link'], 'build', {timeout: 60000});
  const web = `${scratch}/web`; await mkdir(web, {mode: 0o700});
  for (const name of ['index.html', 'app.js', 'app.css']) { await copyFile(`${root}/web/${name}`, `${web}/${name}`); report.assets[name] = hash(await readFile(`${web}/${name}`)); }
  ownerKeyPath = `${scratch}/owner.private.json`;
  await command(binary, ['bootstrap-owner', '--database-url-file', dsnPath, '--owner-id', ids.owner, '--owner-name', 'Isolated browser owner', '--key-out', ownerKeyPath], 'bootstrap-owner');
  const credential = JSON.parse((await privateRead(ownerKeyPath)).toString('utf8'));
  assert(credential.agent_id === ids.owner, 'Wrong fresh fixture owner'); keys.owner = credential.key; secrets.add(keys.owner);
  const reservation = net.createServer(); await new Promise((resolveListen, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolveListen); });
  const port = reservation.address().port; await new Promise(resolveClose => reservation.close(resolveClose));
  base = `https://127.0.0.1:${port}/`; report.base = base;
  ca = await readFile(caPath);
  serverLog = await open(`${directory}/server.private.log`, 'wx', 0o600);
  server = spawn(binary, ['serve', '--database-url-file', dsnPath, '--listen', `127.0.0.1:${port}`, '--tls-cert', `${runtime}/secrets/server.crt`,
    '--tls-key', `${runtime}/secrets/server.key`, '--web-dir', web, '--public-url', new URL(base).origin,
    '--onboarding-ca-file', caPath], {cwd: root, stdio: ['ignore', serverLog.fd, serverLog.fd]});
  let spawnFailed = false; server.once('error', () => { spawnFailed = true; });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    assert(!spawnFailed && server.exitCode === null, 'Owned TLS API exited');
    try { ready = (await api('/v1/me')).agent.id === ids.owner; if (ready) break; } catch {}
    await pause(100);
  }
  assert(ready, 'Owned TLS API did not start');
}
function request(path, method = 'GET', body, actor = 'owner', raw = false) {
  const url = new URL(path, base);
  assert(url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.origin === new URL(base).origin, 'Fixture API refuses nonowned origin');
  return new Promise((resolveRequest, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(url, {ca, method, timeout: 10000, headers: {...(actor === null ? {} : {Authorization: `Bearer ${keys[actor]}`}),
      ...(payload === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)})}}, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('end', () => {
        try { const bytes = Buffer.concat(chunks); resolveRequest({status: res.statusCode, headers: res.headers, data: raw ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null}); }
        catch { reject(new Error('Owned API invalid response')); }
      });
    });
    req.on('error', () => reject(new Error('Owned certificate-verified API unavailable'))); req.on('timeout', () => req.destroy()); req.end(payload);
  });
}
async function api(path, method = 'GET', body, actor = 'owner', expected = 200) {
  const result = await request(path, method, body, actor); assert(result.status === expected, `${method} ${path.split('?')[0]} status ${result.status}, expected ${expected}`); return result.data;
}

async function invite(name) {
  const result = await api('/v1/admin/onboarding', 'POST', {id:ids[name], name:`Fixture ${name}`, project_id:ids.project,
    channel_ids:[ids.channel], runtime:'auto', expires_in_hours:1}, 'owner', 201);
  secrets.add(result.token);
  return result;
}
async function invitationStatus(result) {
  return (await api('/v1/admin/onboarding')).invitations.find(item=>item.id===result.invitation.id)?.status;
}
async function guiCommand(result) {
  // Evaluate the actual source function with inert presentation stubs. This is
  // the GUI's generated command, not a separately maintained shell rendition.
  const source=await readFile(`${root}/web/app.js`,'utf8');
  const start=source.indexOf('  function showOnboardingResult(result) {');
  const end=source.indexOf('  async function onboardingAction(',start);
  assert(start>0 && end>start,'GUI command function boundary changed');
  const elements=new Map();
  const context={URL,state:{},$:id=>{if(!elements.has(id))elements.set(id,{showModal(){},focus(){}});return elements.get(id);},setText(){},tr(){},dateText(){}};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context,{timeout:1000});context.showOnboardingResult(result);
  const command=context.state.onboardingCommand;
  assert(command.includes('bash -o pipefail') && command.includes('--pinnedpubkey') && command.includes('--disable') && command.includes('--noproxy'), 'GUI bootstrap lost transport/failure guards');
  assert(command.includes(result.token) && !command.includes(keys.owner),'GUI command has wrong capability');
  return command;
}
async function runInstaller(result, path, label, {expectedFailure=false, check=true, env=fixtureEnv}={}) {
  const line=await guiCommand(result);
  return command('bash',['-c',line+(check?' --check --runtime codex':'')+' --install-dir '+quote(path)],label,{env,expectedFailure,timeout:60000});
}
async function assertPrivateTree(path) {
  const info=await lstat(path);assert(!info.isSymbolicLink() && !(info.mode&0o077),'Installed file or directory is not private');
  if(info.isDirectory())for(const name of await readdir(path))await assertPrivateTree(join(path,name));
  else assert(info.isFile(),'Installed unexpected special file');
}
async function stopChild(child) {
  for(const signal of ['SIGTERM','SIGKILL'])if(child?.pid && child.exitCode===null && child.signalCode===null){child.kill(signal);await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),pause(2500)]);}
  return !child || !child.pid || child.exitCode!==null || child.signalCode!==null;
}
async function emptyAgentActivity() {
  const query=`SELECT (SELECT count(*) FROM "${schema}".messages)+(SELECT count(*) FROM "${schema}".native_activity)+(SELECT count(*) FROM "${schema}".link_tasks);`;
  assert((await sql(query,'no-agent-writes')).toString().trim()==='0','Connection check published activity/messages/tasks');
  try {await lstat(`${scratch}/model-started`);throw new Error('Provider tripwire executed');}
  catch(error){assert(error.code==='ENOENT','A provider CLI ran during installer check');}
}

try {
  await isolatedServer();
  await api('/v1/admin/projects','POST',{id:ids.project,name:'Installer fixture project'},'owner',201);
  for(const name of ['channel','private'])await api('/v1/admin/channels','POST',{id:ids[name],name:ids[name],project_id:ids.project},'owner',201);
  const fakebin=`${scratch}/fakebin`;await mkdir(fakebin,{mode:0o700});
  for(const name of ['codex','claude'])await writeFile(`${fakebin}/${name}`,`#!/bin/sh\nprintf 'unexpected model launch\\n' > ${quote(`${scratch}/model-started`)}\nexit 99\n`,{mode:0o700,flag:'wx'});
  fixtureEnv={...process.env,PATH:`${fakebin}:${process.env.PATH}`};
  let success;
  await check('exact GUI command redeems and checks real HTTPS grants without starting a model',async()=>{
    success=await invite('install');const path=`${scratch}/installed`;
    const bytes=await runInstaller(success,path,'install-real-check');
    const result=JSON.parse(bytes.toString());
    assert(result.connected===true && result.models_started===false && result.messages_sent===0 && result.agent_id===ids.install
      && result.project_id===ids.project && result.channel_ids.join(',')===ids.channel,'Installed helper check returned wrong identity/scope');
    assert(await invitationStatus(success)==='claimed','Invitation was not consumed');
    await assertPrivateTree(path);
    const key=(await privateRead(`${path}/agent.key`)).toString().trim();secrets.add(key);keys.install=key;
    const config=JSON.parse((await privateRead(`${path}/config.json`)).toString());
    assert(config.workspace_root===`${path}/workspace` && config.key_file===`${path}/agent.key` && config.runtime==='codex','Native config paths/runtime differ');
    assert((await readdir(`${path}/workspace`)).length===0,'Default workspace is not empty');
    assert(hash(await readFile(`${path}/ca.crt`))===hash(ca),'Installed trust certificate differs');
    await api(`/v1/channels/${ids.channel}/messages`,'GET',undefined,'install');
    await api(`/v1/channels/${ids.private}/messages`,'GET',undefined,'install',404);
    await api('/v1/admin/onboarding','GET',undefined,'install',403);
    await emptyAgentActivity();report.installed={agent_id:ids.install,file_mode:'0600',directory_mode:'0700',workspace:'empty',runtime:'codex'};
  });
  await check('repeat helper check preserves config state binding and invitation remains once-only',async()=>{
    const path=`${scratch}/installed`,before=await readFile(`${path}/config.json`);
    const result=JSON.parse((await command('python3',['-B',`${path}/connect.py`,'--check'],'repeat-local-check',{env:fixtureEnv})).toString());
    assert(result.connected && before.equals(await readFile(`${path}/config.json`)),'Repeat check rewrote config');
    await api('/connect/redeem','POST',{token:success.token},null,410);
    await emptyAgentActivity();
  });
  await check('wrong static TLS pin fails pipeline without consuming invitation',async()=>{
    const result=await invite('wrongpin'),path=`${scratch}/wrongpin`;
    const altered={...result,spki_pin:'sha256//'+Buffer.alloc(32,17).toString('base64')};
    await runInstaller(altered,path,'wrong-pin',{expectedFailure:true});
    assert(await invitationStatus(result)==='pending','Wrong pin consumed invitation');
    try{await lstat(path);throw new Error('Wrong pin installed files');}catch(error){assert(error.code==='ENOENT','Wrong pin changed destination');}
  });
  await check('existing destination refuses before consuming invitation and preserves files',async()=>{
    const result=await invite('collision'),path=`${scratch}/existing`;await mkdir(path,{mode:0o700});await writeFile(`${path}/keep`,'original',{mode:0o600,flag:'wx'});
    await runInstaller(result,path,'destination-collision',{expectedFailure:true});
    assert(await invitationStatus(result)==='pending' && (await readFile(`${path}/keep`,'utf8'))==='original','Collision consumed invitation or changed existing data');
  });
  await check('normal launch without terminal refuses before consuming invitation',async()=>{
    const result=await invite('notty');await runInstaller(result,`${scratch}/notty`,'no-controlling-tty',{expectedFailure:true,check:false});
    assert(await invitationStatus(result)==='pending','Absent terminal consumed invitation');
    await emptyAgentActivity();
  });
  await check('lost redemption response commits once and installer refuses without retry',async()=>{
    const result=await invite('lost'),bin=`${scratch}/lostbin`,counter=`${scratch}/redeem-count`;
    await mkdir(bin,{mode:0o700});
    const realCurl=(await command('bash',['-c','command -v curl'],'locate-curl')).toString().trim();assert(realCurl.startsWith('/'),'curl path is not absolute');
    const wrapper=`#!/usr/bin/env python3\nimport os,subprocess,sys\na=sys.argv[1:]\nif a and a[-1].endswith('/connect/redeem'):\n with open(${JSON.stringify(counter)},'a') as f:f.write('redeem\\n')\n subprocess.run([${JSON.stringify(realCurl)},*a],stdin=sys.stdin.buffer,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n sys.exit(18)\nos.execv(${JSON.stringify(realCurl)},[${JSON.stringify(realCurl)},*a])\n`;
    await writeFile(`${bin}/curl`,wrapper,{mode:0o700,flag:'wx'});
    const output=await runInstaller(result,`${scratch}/lost`,'lost-response',{expectedFailure:true,env:{...fixtureEnv,PATH:`${bin}:${fixtureEnv.PATH}`}});
    assert(output.stderr.toString().includes('uncertain'),'Lost response did not explain ambiguity');
    assert(await invitationStatus(result)==='claimed','Discarded response did not commit server claim');
    assert((await readFile(counter,'utf8'))==='redeem\n','Installer retried ambiguous redemption');
    await emptyAgentActivity();
  });
} catch(error) {
  if(!report.cases.some(item=>!item.passed))report.cases.push({name:'infrastructure',passed:false,error:safeError(error)});
} finally {
  report.owned_server_stopped=await stopChild(server);if(serverLog)await serverLog.close();
  if(schemaCreated && report.owned_server_stopped){try{await sql(`DROP SCHEMA "${schema}" CASCADE;`,'drop-owned-schema');report.owned_schema_removed=true;}catch{report.owned_schema_removed=false;}}
  else report.owned_schema_removed=!schemaCreated;
  try{report.source_test_DSN_unchanged=hash(await privateRead(`${runtime}/secrets/agentlink_test-dsn`))===sourceDSNHash;}catch{report.source_test_DSN_unchanged=false;}
  if(scratch && report.owned_server_stopped && report.owned_schema_removed)await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  report.finished_at=new Date().toISOString();report.success=report.cases.length===6 && report.cases.every(item=>item.passed) && report.owned_server_stopped && report.owned_schema_removed && report.source_test_DSN_unchanged;
  const output=directory?`${directory}/evidence.json`:`${runtime}/evidence/onboarding-installer-setup-failed-${randomUUID()}.json`;
  let serialized=JSON.stringify(report,null,2)+'\n';for(const key of secrets)serialized=serialized.replaceAll(key,'[REDACTED]');
  await writeFile(output,serialized,{mode:0o600,flag:'wx'});console.log(JSON.stringify({success:report.success,cases:report.cases.length,owned_server_stopped:report.owned_server_stopped,owned_schema_removed:report.owned_schema_removed,evidence:output}));
}
if(!report.success)process.exitCode=1;
