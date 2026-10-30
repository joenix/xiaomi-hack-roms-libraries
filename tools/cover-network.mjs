/** Bounded retrying HTTP fetch. Each attempt owns its AbortController; never share it between games. */
export class CoverNetworkError extends Error {
  constructor(message,{kind='network',status=null,attempts=0}={}){super(message);this.name='CoverNetworkError';this.kind=kind;this.status=status;this.attempts=attempts;}
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function classifyCoverError(error){
  if(error?.kind)return error.kind;
  if(error?.name==='AbortError'||error?.name==='TimeoutError'||/abort|timeout|timed? out/i.test(String(error?.message)))return 'timeout';
  if(error?.status===429)return 'rate-limit';
  if(error?.status>=500)return 'server-error';
  if(error?.status===404)return 'not-found';
  if(error?.status>=400)return 'http-error';
  return 'network';
}
export function retryable(error){return ['timeout','network','server-error','rate-limit'].includes(classifyCoverError(error));}
export async function fetchWithRetry(url,{fetchImpl=fetch,timeoutMs=30000,retries=2,baseDelayMs=700,wait=sleep,maxBytes=12*1024*1024,headers={},method='GET',body}={}){
  let last;
  for(let attempt=0;attempt<=retries;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl(url,{signal:controller.signal,method,body,headers:{'User-Agent':'xiaomi-hack-roms/0.8.6 (retro cover metadata)',...headers}});
      if(!response.ok){const err=new CoverNetworkError(`HTTP ${response.status}`,{kind:classifyCoverError({status:response.status}),status:response.status});throw err;}
      if(Number(response.headers?.get?.('content-length')||0)>maxBytes)throw new CoverNetworkError('远程文件大小超过上限',{kind:'invalid-data'});
      const chunks=[];let size=0;
      if(response.body && Symbol.asyncIterator in response.body){
        for await (const chunk of response.body){size+=chunk.byteLength;if(size>maxBytes)throw new CoverNetworkError('远程数据超过上限',{kind:'invalid-data'});chunks.push(Buffer.from(chunk));}
      }else{
        const raw=Buffer.from(await response.arrayBuffer());size=raw.length;
        if(size>maxBytes)throw new CoverNetworkError('远程数据超过上限',{kind:'invalid-data'});
        chunks.push(raw);
      }
      return Buffer.concat(chunks);
    }catch(error){
      const kind=controller.signal.aborted?'timeout':classifyCoverError(error);
      last=error instanceof CoverNetworkError?error:new CoverNetworkError(kind==='timeout'?`请求超时（${timeoutMs/1000} 秒）`:`网络请求失败：${error.message}`,{kind});
      last.attempts=attempt+1;
      if(attempt>=retries||!retryable(last))break;
      await wait(Math.min(12000,baseDelayMs*2**attempt));
    }finally{clearTimeout(timer);}
  }
  throw last;
}
export function mediaType(buffer){
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return '.png';
  if(buffer.length>=3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return '.jpg';
  if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return '.webp';
  return null;
}
