#!/usr/bin/env python3
"""Linux root-owned test launcher. Install a fixed wrapper with a configured root.

The candidate controls neither commands, mounts nor environment. Copies only
regular source files into a disposable read-only tree; no network, production
data, credentials or host home is mounted into the child. A separate systemd
unit bounds aggregate memory/processes and the bwrap child runs without root capabilities.
"""
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import uuid

def run(root, workspace, kind, dependencies=None):
    root=Path(root).resolve(strict=True)
    workspace=Path(workspace)
    if workspace.is_symlink() or workspace.resolve(strict=True)!=workspace or not workspace.is_relative_to(root):
        raise ValueError('Workspace outside configured development root')
    if kind not in ('syntax','test'):
        raise ValueError('Unsupported validation identifier')
    current=workspace
    while current!=root:
        if current.is_symlink():raise ValueError('Symlink workspace rejected')
        current=current.parent
    with tempfile.TemporaryDirectory(prefix='liveui-development-test-') as tmp:
        tree=Path(tmp)/'source';tree.mkdir(mode=0o755)
        total=0
        def copy_folder(parent_fd,destination):
            nonlocal total
            for name in os.listdir(parent_fd):
                if name in ('.git','node_modules','dist-server','dist'):continue
                fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent_fd)
                try:
                    metadata=os.fstat(fd)
                    if stat.S_ISDIR(metadata.st_mode):
                        out=destination/name;out.mkdir(mode=0o755);copy_folder(fd,out)
                    elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink==1:
                        if metadata.st_size>8*1024*1024:raise ValueError('Source file too large')
                        data=b''
                        while True:
                            part=os.read(fd,min(65536,8*1024*1024+1-len(data)))
                            if not part:break
                            data+=part
                            if len(data)>8*1024*1024:raise ValueError('Source file grew beyond budget')
                        total+=len(data)
                        if total>64*1024*1024:raise ValueError('Source budget exceeded')
                        out=destination/name;out.write_bytes(data);out.chmod(0o644)
                    else:raise ValueError('Nonregular or hard-linked source rejected')
                finally:os.close(fd)
        root_fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
        try:
            for part in workspace.parts[1:]:
                next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root_fd)
                os.close(root_fd);root_fd=next_fd
            copy_folder(root_fd,tree)
        finally:os.close(root_fd)
        dependency_mount=[]
        if dependencies:
            deps=Path(dependencies).resolve(strict=True)
            if not deps.is_dir() or deps.is_relative_to(root):raise ValueError('Invalid trusted dependency root')
            (tree/'node_modules').mkdir(mode=0o755)
            dependency_mount=['--ro-bind',str(deps),'/workspace/node_modules']
        if kind=='test':
            test=tree/'tests/development.test.mjs'
            if not test.is_file():raise ValueError('Write tests/development.test.mjs before running test')
            command=['/usr/bin/node','--max-old-space-size=256',*(['--import','tsx'] if dependencies else []),'--test','tests/development.test.mjs']
        else:
            # Parse changed JavaScript without importing/executing candidate code.
            script="""const fs=require('fs'),cp=require('child_process'),path=require('path');
let count=0;function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(/\\.(mjs|cjs|js)$/.test(e.name)){const r=cp.spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr);process.exit(1);}count++;}}}walk('/workspace');console.log(JSON.stringify({parsedJavaScriptFiles:count,typescriptTypecheck:false}));"""
            command=['/usr/bin/node','--max-old-space-size=256','-e',script]
        mounts=[]
        for d in ['/usr/lib','/usr/lib64','/lib','/lib64']:
            if Path(d).exists():mounts+=['--ro-bind',d,d]
        # Only node itself from /usr/bin. No shells, interpreters or sudo in child.
        args=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','65534','--gid','65534','--cap-drop','ALL',
              '--dir','/usr/bin','--ro-bind',str(Path('/usr/bin/node').resolve()),'/usr/bin/node',*mounts,
              '--ro-bind',str(tree),'/workspace',*dependency_mount,'--size','67108864','--tmpfs','/tmp','--proc','/proc','--dev','/dev',
              '--chdir','/workspace','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','PATH','/usr/bin',
              '--setenv','LANG','C.UTF-8',*command]
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE,(2*1024*1024,2*1024*1024))
            resource.setrlimit(resource.RLIMIT_NPROC,(64,64))
            resource.setrlimit(resource.RLIMIT_CPU,(45,45))
            resource.setrlimit(resource.RLIMIT_AS,(16*1024*1024*1024,16*1024*1024*1024))
        unit='liveui-development-test-'+uuid.uuid4().hex
        args=['/usr/bin/systemd-run','--quiet','--wait','--pipe','--collect','--unit='+unit,
              '--property=MemoryMax=768M','--property=MemorySwapMax=0','--property=TasksMax=48',
              '--property=RuntimeMaxSec=120','--property=LimitCPU=45','--property=LimitFSIZE=2097152',
              '--',*args]
        with tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err:
            p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=out,stderr=err,env={'PATH':'/usr/bin:/bin'},start_new_session=True,preexec_fn=limits)
            try:code=p.wait(timeout=125)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid,signal.SIGKILL);p.wait();code=124
            finally:
                subprocess.run(['/usr/bin/systemctl','stop',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
                try:os.killpg(p.pid,signal.SIGKILL)
                except ProcessLookupError:pass
            out.seek(0);err.seek(0)
            sys.stdout.buffer.write(out.read(1024*1024));sys.stderr.buffer.write(err.read(1024*1024))
            return code

if __name__=='__main__':
    try:
        if len(sys.argv) not in (4,5):raise ValueError('Expected configured root, workspace, validation identifier and optional trusted dependencies')
        sys.exit(run(sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4] if len(sys.argv)==5 else None))
    except Exception as error:
        print('Development test refused: '+str(error),file=sys.stderr);sys.exit(2)
