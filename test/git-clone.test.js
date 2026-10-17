const {test}=require('node:test');
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {normalizeUrl,repoName,checkName,destination,clone}=require('../lib/git-clone');
const run=opts=>new Promise(resolve=>{const task=clone({...opts,onDone:resolve});opts.onStart?.(task);});

test('accepts https and ssh repo links, trims browser links, refuses other transports',()=>{
  assert.equal(normalizeUrl('https://github.com/7LayerLabs/vibedeck.git'),'https://github.com/7LayerLabs/vibedeck.git');
  assert.equal(normalizeUrl(' "https://github.com/7LayerLabs/vibedeck" '),'https://github.com/7LayerLabs/vibedeck.git');
  assert.equal(normalizeUrl('github.com/7LayerLabs/vibedeck/tree/main/lib'),'https://github.com/7LayerLabs/vibedeck.git');
  assert.equal(normalizeUrl('https://www.github.com/owner/my.repo?tab=readme'),'https://github.com/owner/my.repo.git');
  assert.equal(normalizeUrl('https://gitlab.com/group/sub/project.git'),'https://gitlab.com/group/sub/project.git');
  assert.equal(normalizeUrl('git@github.com:owner/repo.git'),'git@github.com:owner/repo.git');
  assert.equal(normalizeUrl('ssh://git@example.com:2222/owner/repo.git'),'ssh://git@example.com:2222/owner/repo.git');
  for(const bad of ['','file:///C:/secrets','ext::sh -c touch% /tmp/x','C:\\Users\\me\\repo','../repo','-uhttps://x.y/z','http://github.com/o/r','https://token@github.com/o/r'])
    assert.throws(()=>normalizeUrl(bad),/https or ssh/,bad);
});

test('folder name comes from the link and must be a single safe name',()=>{
  assert.equal(repoName('https://github.com/owner/repo.git'),'repo');
  assert.equal(repoName('git@github.com:owner/repo.git'),'repo');
  assert.equal(repoName('https://gitlab.com/group/sub/project/'),'project');
  assert.equal(checkName(' my-app '),'my-app');
  for(const bad of ['','.','..','a/b','a\\b','c:','what?','trailing.','CON','nul.txt'])assert.throws(()=>checkName(bad),/usable folder name/,bad);
});

test('destination needs a real parent folder and a missing or empty target',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vibedeck clone '));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.deepEqual(destination(dir,'fresh'),{target:path.join(dir,'fresh'),existed:false});
  fs.mkdirSync(path.join(dir,'empty'));
  assert.deepEqual(destination(`"${dir}"`,'empty'),{target:path.join(dir,'empty'),existed:true});
  fs.mkdirSync(path.join(dir,'full'));fs.writeFileSync(path.join(dir,'full','keep.txt'),'mine');
  assert.throws(()=>destination(dir,'full'),/already has files/);
  fs.writeFileSync(path.join(dir,'afile'),'x');
  assert.throws(()=>destination(dir,'afile'),/A file named afile/);
  assert.throws(()=>destination(path.join(dir,'missing'),'x'),/does not exist/);
  assert.throws(()=>destination('relative\\path','x'),/full folder path/);
  assert.throws(()=>destination('','x'),/Choose where/);
  assert.equal(fs.readFileSync(path.join(dir,'full','keep.txt'),'utf8'),'mine');
});

test('clones a repo, and a failed or cancelled clone leaves nothing behind',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vibedeck clone '));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const src=path.join(dir,'src');fs.mkdirSync(src);
  const git=(...args)=>execFileSync('git',args,{cwd:src,stdio:'ignore'});
  git('init','-q');fs.writeFileSync(path.join(src,'hello.txt'),'hi');git('add','.');
  git('-c','user.name=t','-c','user.email=t@t','commit','-q','-m','first');

  const done=await run({url:src,target:path.join(dir,'copy'),existed:false});
  assert.deepEqual(done,{ok:true});
  assert.equal(fs.readFileSync(path.join(dir,'copy','hello.txt'),'utf8'),'hi');

  const failed=await run({url:path.join(dir,'no-such-repo'),target:path.join(dir,'bad'),existed:false});
  assert.equal(failed.ok,false);assert.ok(failed.error);
  assert.equal(fs.existsSync(path.join(dir,'bad')),false);

  fs.mkdirSync(path.join(dir,'was-empty'));
  const failedInto=await run({url:path.join(dir,'no-such-repo'),target:path.join(dir,'was-empty'),existed:true});
  assert.equal(failedInto.ok,false);
  assert.deepEqual(fs.readdirSync(path.join(dir,'was-empty')),[]);

  const cancelled=await run({url:src,target:path.join(dir,'stopped'),existed:false,onStart:task=>task.cancel()});
  assert.deepEqual(cancelled,{ok:false,cancelled:true});
  assert.equal(fs.existsSync(path.join(dir,'stopped')),false);
});
