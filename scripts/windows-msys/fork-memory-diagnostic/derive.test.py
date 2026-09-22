import hashlib, importlib.util, json, pathlib, tempfile
ROOT=pathlib.Path(__file__).parents[3]
spec=importlib.util.spec_from_file_location('derive',pathlib.Path(__file__).with_name('derive.py')); mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
native=(ROOT/'agents/codex/workflow/windows-appcontainer-native.cs').read_bytes(); controller=(ROOT/'scripts/windows-msys/mapping-proof/source/mapping-controller.cs').read_bytes()
with tempfile.TemporaryDirectory() as d:
  for name,policy in [('baseline',0),('heva-off',2<<20),('bottom-up-off',2<<16)]:
    out=pathlib.Path(d)/name
    mod.main.__module__
    dn=mod.derive_native(native,policy)
    assert b'GetProcessMitigationPolicy' in dn and b'ForkMemoryPolicyBase64' in dn
    assert (b'MITIGATION_POLICY' in dn) == bool(policy)
    dc=mod.derive_controller(controller)
    assert b'policiesBase64' in dc and b'fork-ok:96' in dc
print('derive variants: 3; policy arms and controller evidence fields verified')
