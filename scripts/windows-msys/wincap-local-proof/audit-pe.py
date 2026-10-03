#!/usr/bin/env python3
"""Observe final DLL COFF placement. Point bounds only; never native acceptance."""
import argparse,hashlib,json,pathlib,struct

def audit(raw):
 def need(value,message):
  if not value:raise ValueError(message)
 def span(offset,size):need(0<=offset<=len(raw) and 0<=size<=len(raw)-offset,'PE bounds')
 def u16(offset):span(offset,2);return struct.unpack_from('<H',raw,offset)[0]
 def u32(offset):span(offset,4);return struct.unpack_from('<I',raw,offset)[0]
 need(256<=len(raw)<=32*1024*1024,'DLL byte bound');need(u16(0)==0x5a4d,'DOS signature')
 pe=u32(60);need(u32(pe)==0x4550 and u16(pe+4)==0x8664,'x64 PE required')
 count=u16(pe+6);symbols_at=u32(pe+12);symbol_count=u32(pe+16);optional=u16(pe+20)
 need(0<count<=96 and 0<symbol_count<=200000 and optional>=112,'PE count bounds')
 span(pe+24,optional);need(u16(pe+24)==0x20b,'PE32+ required')
 section_at=pe+24+optional;span(section_at,count*40);sections=[]
 for index in range(count):
  at=section_at+index*40;size=u32(at+8);rva=u32(at+12);raw_size=u32(at+16);offset=u32(at+20);flags=u32(at+36)
  if raw_size:span(offset,raw_size)
  need(rva+max(size,raw_size)<=0x100000000,'section range')
  sections.append({'name':raw[at:at+8].split(b'\0')[0].decode('ascii'),'rva':rva,'size':max(size,raw_size),'flags':flags})
 span(symbols_at,symbol_count*18);strings_at=symbols_at+symbol_count*18;strings_length=u32(strings_at)
 need(4<=strings_length<=4*1024*1024,'string bounds');span(strings_at,strings_length)
 symbols=[];index=0
 while index<symbol_count:
  at=symbols_at+index*18;aux=raw[at+17];need(index+aux<symbol_count,'auxiliary bounds')
  if u32(at)==0:
   rel=u32(at+4);need(4<=rel<strings_length,'symbol name bounds');end=raw.find(b'\0',strings_at+rel,strings_at+strings_length)
   need(end!=-1 and end-(strings_at+rel)<=512,'symbol name terminator');name=raw[strings_at+rel:end].decode('ascii')
  else:name=raw[at:at+8].split(b'\0')[0].decode('ascii')
  section=struct.unpack_from('<h',raw,at+12)[0];value=u32(at+8)
  if 1<=section<=count:
   owner=sections[section-1];need(value<=owner['size'],'symbol section bounds')
   symbols.append({'name':name,'section':section,'value':value,'rva':owner['rva']+value})
  index+=1+aux
 def one(name):
  matches=[s for s in symbols if s['name']==name];need(len(matches)==1,'unique '+name);return matches[0]
 target=one('wincap');data_start=one('__data_start__');data_end=one('__data_end__');bss_start=one('__bss_start__');bss_end=one('__bss_end__')
 for start,end in [(data_start,data_end),(bss_start,bss_end)]:need(start['section']==end['section'] and start['rva']<=end['rva'],'copy interval order')
 section=sections[target['section']-1]
 need(section['name']=='.data' and target['section']==data_end['section'],'wincap must be in final private data section')
 need(section['flags']&0xc0000000==0xc0000000 and not section['flags']&0x30000000,'wincap section must be readable/writable, non-executable and non-shared')
 need(target['rva']>=data_end['rva'] and target['value']<section['size'],'wincap point must follow copied DLL data')
 need(not bss_start['rva']<=target['rva']<bss_end['rva'],'wincap point must be outside copied BSS')
 following=[s['value'] for s in symbols if s['section']==target['section'] and s['value']>target['value']]
 return {'schema':1,'accepted':False,'dllSha256':hashlib.sha256(raw).hexdigest(),'wincapRva':target['rva'],'section':section,'dataCopyInterval':[data_start['rva'],data_end['rva']],'bssCopyInterval':[bss_start['rva'],bss_end['rva']],'nextSymbolDistance':min(following)-target['value'] if following else None,'objectSize':None,'scope':'COFF symbol point and final section ownership; no complete object extent or native behavior claim'}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('dll',type=pathlib.Path);p.add_argument('--output',type=pathlib.Path);a=p.parse_args();result=audit(a.dll.read_bytes());text=json.dumps(result,indent=2)+'\n'
 if a.output:
  with a.output.open('x') as out:out.write(text)
 print(text,end='')
