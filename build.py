import pathlib
t = pathlib.Path("template.html").read_text()
t = t.replace("/*__DATA__*/", pathlib.Path("data.js").read_text()).replace("/*__ENGINE__*/", pathlib.Path("engine.js").read_text())
pathlib.Path("index.html").write_text(t)
print(len(t))
