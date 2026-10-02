// Own the legacy suites' required Chromium instead of attaching to a user's tab.
import {readFile, mkdtemp, rm, open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash, X509Certificate} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {repositoryRoot, runtimeDir, certificateFile, browserExecutable} from '../scripts/operator-config.mjs';

process.umask(0o077);
const runtime=runtimeDir(), chrome=browserExecutable(), caPath=certificateFile();
const base='https://127.0.0.1:18769/';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reservation=net.createServer();
await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(9222,'127.0.0.1',resolve);});
await new Promise(resolve=>reservation.close(resolve));
const profile=await mkdtemp(join(tmpdir(),'agent-link-legacy-gui-'));
const log=await open(join(profile,'owned-browser.log'),'wx',0o600);
const cert=new X509Certificate(await readFile(caPath));
const spki=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('base64');
const browser=spawn(chrome,[
  '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking',
  '--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9222',`--user-data-dir=${profile}`,`--ignore-certificate-errors-spki-list=${spki}`,base
],{stdio:['ignore',log.fd,log.fd]});
const environment={...process.env,AGENT_LINK_ORIGIN:new URL(base).origin,
  AGENT_LINK_GUI_OWNER_FILE:`${runtime}/secrets/admin-e2e-owner.json`,
  AGENT_LINK_GUI_CREDENTIALS_FILE:`${runtime}/secrets/e2e-credentials.json`};
let passed=true;
try {
  let ready=false;
  for(let i=0;i<100;i++){
    if(browser.exitCode!==null)throw new Error('owned browser exited');
    try{const tabs=await(await fetch('http://127.0.0.1:9222/json/list')).json();ready=tabs.some(t=>t.url.startsWith(base));}catch{}
    if(ready)break;await pause(100);
  }
  if(!ready)throw new Error('owned browser not ready');
  for(const suite of ['admin_gui_live.mjs','project_lifecycle_gui.mjs']){
    const child=spawn(process.execPath,[join(repositoryRoot,'tests',suite)],{env:environment,stdio:'inherit'});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    console.log(JSON.stringify({suite,exit_code:code}));
    if(code!==0){passed=false;break;}
  }
}finally{
  if(browser.exitCode===null){browser.kill('SIGTERM');await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),pause(3000)]);}
  if(browser.exitCode===null){browser.kill('SIGKILL');await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),pause(3000)]);}
  await log.close();
  if(browser.exitCode!==null)await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  else {passed=false;console.log(JSON.stringify({owned_browser_exit_unconfirmed:true,retained_profile:profile}));}
}
if(!passed)process.exitCode=1;
