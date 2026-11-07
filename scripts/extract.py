"""Extract the exact approved artifact without printing commercial file content/names."""
import hashlib, json, pathlib, stat, tarfile, zipfile

root = pathlib.Path('.private')
release = json.loads(pathlib.Path('releases/web.json').read_text())
with zipfile.ZipFile(root / 'source.zip') as z:
    members = z.infolist()
    assert len(members) <= 10
    assert all(not pathlib.PurePosixPath(m.filename).is_absolute() and '..' not in pathlib.PurePosixPath(m.filename).parts and '\\' not in m.filename and not stat.S_ISLNK(m.external_attr >> 16) for m in members)
    assert sum(m.file_size for m in members) <= 128 * 1024 * 1024
    assert release['archive'] in z.namelist()
    archive = z.read(release['archive'])
    expected = release.get('archive_sha256')
    if release.get('mode') == 'auto' and expected is None:
        # The zip digest was already matched to the digest GitHub recorded at build time,
        # so the checksum file inside it is covered by that verified digest.
        sums = z.read('SHA256SUMS-web').decode('ascii').split()
        assert len(sums) == 2 and sums[1] == release['archive']
        expected = sums[0]
assert expected and len(expected) == 64
assert hashlib.sha256(archive).hexdigest() == expected
archive_path = root / release['archive']
archive_path.write_bytes(archive)
with tarfile.open(archive_path, 'r:gz') as t:
    members = t.getmembers()
    assert len(members) <= 15000
    assert sum(m.size for m in members) <= 512 * 1024 * 1024
    assert all((m.isfile() or m.isdir()) and not pathlib.PurePosixPath(m.name).is_absolute() and '..' not in pathlib.PurePosixPath(m.name).parts and '\\' not in m.name for m in members)
    t.extractall(root / 'delivery', filter='data')
print('Approved archive safely extracted without executing application code.')
