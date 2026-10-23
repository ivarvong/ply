G=$1; export GIT_AUTHOR_NAME=w GIT_AUTHOR_EMAIL=w@x GIT_COMMITTER_NAME=w GIT_COMMITTER_EMAIL=w@x
rm -rf w b.git; git init -q -b main w; cd w
seq 1 20 > f; git add f; git commit -qm base
# where the attribute lives: $2 in {none, ours, theirs, base, all}
mk(){ echo "f merge=binary" > .gitattributes; git add .gitattributes; }
[ "$2" = base -o "$2" = all ] && { mk; git commit -qm attr; }
git checkout -qb feat; sed -i 's/^20$/TWENTY/' f; git add f; [ "$2" = theirs ] && mk; git commit -qm theirs
git checkout -q main; sed -i 's/^1$/ONE/' f; git add f; [ "$2" = ours ] && mk; git commit -qm ours
cd ..; git clone -q --bare w b.git
# HEAD of the bare repo is main (= ours); also try HEAD pointing at feat
r1=$($G -C b.git merge-tree --write-tree main feat >/dev/null 2>&1; echo $?)
git -C b.git symbolic-ref HEAD refs/heads/feat
r2=$($G -C b.git merge-tree --write-tree main feat >/dev/null 2>&1; echo $?)
echo "attr in $2: HEAD=ours→$r1 HEAD=theirs→$r2   (0 clean, 1 conflict)"
