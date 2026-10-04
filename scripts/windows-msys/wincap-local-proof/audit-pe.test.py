#!/usr/bin/env python3
"""Synthetic bounded COFF controls, not native DLL evidence."""
import pathlib,runpy,struct
HERE=pathlib.Path(__file__).resolve().parent
audit=runpy.run_path(str(HERE/'audit-pe.py'))['audit']
def image(flags=0xc0000040,target=0x120,data_end=0x100,duplicate=False):
 raw=bytearray(4096)
 def w16(offset,value):struct.pack_into('<H',raw,offset,value)
 def w32(offset,value):struct.pack_into('<I',raw,offset,value)
 w16(0,0x5a4d);w32(60,128);w32(128,0x4550);w16(132,0x8664);w16(134,2);w32(140,1280);w16(148,240);w16(152,0x20b)
 for at,name,rva,size,offset,attr in [(392,b'.data',4096,512,512,flags),(432,b'.bss',8192,256,1024,0xc0000080)]:
  raw[at:at+len(name)]=name;w32(at+8,size);w32(at+12,rva);w32(at+16,size);w32(at+20,offset);w32(at+36,attr)
 records=[('wincap',1,target),('__data_start__',1,0),('__data_end__',1,data_end),('__bss_start__',2,0),('__bss_end__',2,256),('following',1,0x1a0)]
 if duplicate:records.append(('wincap',1,target))
 w32(144,len(records));strings=bytearray(b'\0'*4)
 for i,(name,section,value) in enumerate(records):
  at=1280+i*18;w32(at+4,len(strings));strings+=name.encode()+b'\0';w32(at+8,value);w16(at+12,section);raw[at+16]=2
 struct.pack_into('<I',strings,0,len(strings));start=1280+len(records)*18;raw[start:start+len(strings)]=strings
 return raw
result=audit(image());assert result['wincapRva']==0x1120 and result['nextSymbolDistance']==0x80 and result['objectSize'] is None and result['accepted'] is False
cases=[image(flags=0xd0000040),image(flags=0xe0000040),image(flags=0x40000040),image(target=0x80),image(data_end=0x140),image(duplicate=True),image()[:200]]
wrong_machine=image();struct.pack_into('<H',wrong_machine,132,0xaa64);cases.append(wrong_machine)
for candidate in cases:
 try:audit(candidate)
 except ValueError:pass
 else:raise AssertionError('invalid PE placement/control accepted')
print('PE ownership parser: positive private placement and eight rejection controls passed; synthetic only')
