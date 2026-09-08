"""Build the static site with content-addressed CSS/JS for returning visitors."""
from hashlib import sha256
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
source = root / 'site'
output = root / '_site'
if output.exists():
    shutil.rmtree(output)
shutil.copytree(source, output)
html = (output / 'index.html').read_text()
for asset in sorted(output.iterdir()):
    if asset.suffix not in {'.css', '.js'}:
        continue
    fingerprint = sha256(asset.read_bytes()).hexdigest()[:12]
    name = f'{asset.stem}.{fingerprint}{asset.suffix}'
    html = html.replace(f'"./{asset.name}"', f'"./{name}"')
    asset.rename(output / name)
(output / 'index.html').write_text(html)
print('Built _site with fingerprinted CSS and JavaScript.')
