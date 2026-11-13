"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "radix-ui";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { matchesAssetSearch, networkIdentity } from "@/lib/asset-identity";
import type { AssetChoice } from "@/lib/native-usdc";
import { AssetIdentity, NetworkIdentity } from "./asset-identity";

type AssetOption=Pick<AssetChoice,"assetId"|"symbol"|"blockchain"|"contractAddress">;
interface Choice {value:string;symbol?:string;network:string;label?:string;detail?:string;keywords?:string;asset?:AssetOption;disabled?:boolean}
interface PickerProps {label:string;choices:Choice[];value?:string;defaultValue?:string;onValueChange?:(value:string)=>void;name?:string;placeholder?:string;disabled?:boolean;required?:boolean;allowEmpty?:boolean;emptyLabel?:string}

function IdentityPicker({label,choices,value,defaultValue="",onValueChange,name,placeholder="Choose an asset",disabled=false,required=false,allowEmpty=false,emptyLabel="None"}:PickerProps) {
  const [internal,setInternal]=useState(defaultValue),[open,setOpen]=useState(false),[search,setSearch]=useState(""),[limit,setLimit]=useState(80),[invalid,setInvalid]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null),searchInput=useRef<HTMLInputElement>(null),native=useRef<HTMLSelectElement>(null),optionButtons=useRef<Array<HTMLButtonElement|null>>([]),id=useId(),selectedValue=value??internal;
  const selected=choices.find(choice=>choice.value===selectedValue);
  const allChoices=allowEmpty?[{value:"",label:emptyLabel,network:""},...choices]:choices;
  const filtered=allChoices.filter(choice=>choice.asset?matchesAssetSearch(choice.asset,search):search.trim().toLowerCase().split(/\s+/).every(term=>`${choice.label || ""} ${choice.network} ${networkIdentity(choice.network).name} ${choice.detail || ""} ${choice.keywords || ""}`.toLowerCase().includes(term)));
  const visible=filtered.slice(0,limit);
  useEffect(()=>{
    if(value!==undefined)return;
    const form=native.current?.form;
    const reset=()=>{setInternal(defaultValue);setInvalid(false);};
    form?.addEventListener("reset",reset);
    return ()=>form?.removeEventListener("reset",reset);
  },[defaultValue,value]);
  useEffect(()=>{
    if(value===undefined&&internal&&!choices.some(choice=>choice.value===internal))setInternal("");
  },[choices,internal,value]);
  function choose(next:string) {
    if(disabled||choices.find(choice=>choice.value===next)?.disabled)return;
    if(value===undefined)setInternal(next);
    onValueChange?.(next);setInvalid(false);setOpen(false);
  }
  function move(event:KeyboardEvent<HTMLElement>,index:number) {
    const enabled=visible.flatMap((choice,position)=>choice.disabled?[]:[position]),current=Math.max(0,enabled.indexOf(index));
    const next=event.key==="ArrowDown"?Math.min(current+1,enabled.length-1):event.key==="ArrowUp"?Math.max(current-1,0):event.key==="Home"?0:event.key==="End"?enabled.length-1:null;
    if(next!==null){event.preventDefault();optionButtons.current[enabled[next]]?.focus();}
  }
  function identity(choice:Choice,full=false) {
    return choice.symbol?<span className="min-w-0"><AssetIdentity symbol={choice.symbol} network={choice.network} assetId={choice.detail} showAssetId={full}/>{choice.disabled?<span className="mt-1 block text-xs font-normal text-muted-foreground">Saved preference, outside the live catalog</span>:null}</span>:choice.network?<NetworkIdentity network={choice.network} label={choice.label}/>:<span className="text-sm">{choice.label}</span>;
  }
  return <span className="block min-w-0">
    <Dialog.Root open={open&&!disabled} onOpenChange={next=>{setOpen(next);if(next){setSearch("");setLimit(80);}}}>
      <Dialog.Trigger asChild><button ref={trigger} type="button" disabled={disabled} aria-label={`${label}: ${selected?selected.symbol?`${selected.symbol} on ${networkIdentity(selected.network).name}`:selected.label || networkIdentity(selected.network).name:selectedValue || (allowEmpty?emptyLabel:placeholder)}`} aria-invalid={invalid || undefined} aria-describedby={invalid?`${id}-error`:undefined} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-input bg-background px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
        {selected?identity(selected):<span className="min-w-0 break-all text-muted-foreground">{selectedValue || (allowEmpty?emptyLabel:placeholder)}</span>}<ChevronDown size={16} className="shrink-0 text-muted-foreground" aria-hidden="true"/>
      </button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/40"/><Dialog.Content onOpenAutoFocus={event=>{event.preventDefault();searchInput.current?.focus();}} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-4 shadow-xl outline-none sm:p-5">
        <div className="flex items-center justify-between gap-4"><Dialog.Title className="text-lg font-semibold">{label}</Dialog.Title><Dialog.Close asChild><button type="button" aria-label="Close asset selection" className="rounded-md p-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X size={18}/></button></Dialog.Close></div>
        <Dialog.Description className="mt-2 text-xs leading-5 text-muted-foreground">Choose the exact asset and network. Logos help identify choices; the displayed asset identity controls your selection.</Dialog.Description>
        <div className="relative mt-4"><Search size={17} className="pointer-events-none absolute left-3 top-3 text-muted-foreground" aria-hidden="true"/><input ref={searchInput} autoComplete="off" spellCheck={false} aria-label={`Search ${label.toLowerCase()}`} aria-controls={`${id}-choices`} className="h-11 w-full rounded-lg border border-input bg-background pl-10 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={search} onChange={event=>{setSearch(event.target.value);setLimit(80);}} onKeyDown={event=>{if(event.key==="ArrowDown"&&visible.length){event.preventDefault();optionButtons.current[visible.findIndex(choice=>!choice.disabled)]?.focus();}}} placeholder="Search token, network or full asset ID"/></div>
        <p className="my-3 text-xs text-muted-foreground" role="status">{filtered.length} matching {filtered.length===1?"choice":"choices"}</p>
        <div id={`${id}-choices`} role="listbox" aria-label={label} className="max-h-[min(55dvh,24rem)] space-y-1 overflow-y-auto overscroll-contain">
          {visible.length?visible.map((choice,index)=><button key={choice.value || "empty"} ref={element=>{optionButtons.current[index]=element;}} type="button" role="option" tabIndex={index===visible.findIndex(value=>!value.disabled)?0:-1} aria-selected={selectedValue===choice.value} disabled={disabled||choice.disabled} onKeyDown={event=>move(event,index)} onClick={()=>choose(choice.value)} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            {identity(choice,true)}{selectedValue===choice.value?<Check size={18} className="shrink-0 text-primary" aria-hidden="true"/>:null}
          </button>):<p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No matches. Try a symbol, network name or exact asset ID.</p>}
        </div>
        {visible.length<filtered.length?<button type="button" className="w-full rounded-lg border p-3 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>setLimit(current=>current+80)}>Show more choices ({filtered.length-visible.length} remaining)</button>:null}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <select ref={native} name={name} value={selectedValue} onChange={event=>choose(event.target.value)} disabled={disabled} required={required} tabIndex={-1} aria-hidden="true" className="sr-only" onInvalid={event=>{event.preventDefault();setInvalid(true);trigger.current?.focus();}}>
      <option value="">{allowEmpty?emptyLabel:placeholder}</option>{choices.map(choice=><option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.symbol?`${choice.symbol} on ${networkIdentity(choice.network).name}`:choice.label || networkIdentity(choice.network).name}{choice.detail?` - ${choice.detail}`:""}</option>)}
    </select>
    {invalid?<span id={`${id}-error`} role="alert" className="mt-2 block text-xs text-destructive">Choose {label.toLowerCase()} before continuing.</span>:null}
  </span>;
}

interface AssetPickerProps extends Omit<PickerProps,"choices"> {tokens:readonly AssetOption[];savedAsset?:AssetOption}
export function AssetPicker({tokens,savedAsset,...props}:AssetPickerProps) {
  const options=savedAsset&&!tokens.some(asset=>asset.assetId===savedAsset.assetId)?[savedAsset,...tokens]:tokens;
  return <IdentityPicker {...props} choices={options.map(asset=>({value:asset.assetId,symbol:asset.symbol,network:asset.blockchain,detail:asset.assetId,asset,disabled:asset===savedAsset&&!tokens.some(token=>token.assetId===asset.assetId)}))}/>;
}

interface NetworkPickerProps extends Omit<PickerProps,"choices"> {networks:readonly string[];symbol?:string}
export function NetworkPicker({networks,symbol,...props}:NetworkPickerProps) {
  return <IdentityPicker {...props} choices={networks.map(network=>({value:network,network,symbol,label:networkIdentity(network).name}))}/>;
}
