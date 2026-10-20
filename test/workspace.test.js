const {test}=require('node:test');
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createWorkspace}=require('../lib/workspace');

// a downloaded folder's .git/config can name commands that "git status" would run
test('git status in an opened folder never runs commands from that folder\'s own git config',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vd-ws-'));
  const repos=['fsmonitor','filter'].map(name=>{
    const repo=path.join(dir,name);fs.mkdirSync(repo);
    execFileSync('git',['init','-q',repo]);fs.writeFileSync(path.join(repo,'x.txt'),'hi\n');
    return repo;
  });
  execFileSync('git',['-C',repos[0],'config','core.fsmonitor','echo PWNED > pwned.txt; false']);
  execFileSync('git',['-C',repos[1],'config','filter.evil.clean','echo PWNED > pwned.txt; cat']);
  fs.writeFileSync(path.join(repos[1],'.gitattributes'),'*.txt filter=evil\n');
  try {
    const workspace=createWorkspace({roots:()=>repos});
    const [plain,filtered]=await Promise.all(repos.map(r=>workspace.git(r)));
    assert.equal(plain.repo,true);assert.ok(plain.files['x.txt']);
    assert.equal(filtered.repo,true);assert.deepEqual(filtered.files,{});
    for(const repo of repos)assert.equal(fs.existsSync(path.join(repo,'pwned.txt')),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
