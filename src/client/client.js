window.__ModuleLoader__.load({
 id:'dsh-onebot-bridge',
 factory:(require)=>{
  const React=require('react'),{useState,useEffect}=React,h=React.createElement;
  async function api(action,args={}) {
    let response;try{response=await fetch('/api/qq-bridge',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...args})});}catch{throw new Error('服务连接中断，请稍后重试；写操作不会自动重复执行。');}
    let result;try{result=await response.json();}catch{throw new Error('暂时无法连接插件，请刷新页面重试。');}
    if(!result.ok)throw new Error(result.error||'操作失败');return result.value;
  }
  const UninstallContext=React.createContext(()=>{});
  const labels={identity:'身份与背景',personality:'性格',style:'说话风格',relationship:'称呼与关系',length:'回复长度',behavior:'行为约定',examples:'示例对话',instructions:'补充说明'};
  const copy=x=>JSON.parse(JSON.stringify(x));
  const ownerIds=f=>[...new Set([f.ownerQQ,...(f.ownerQQs||[])].filter(Boolean))];
  const button=(text,fn,props={})=>h('button',{type:'button',onClick:fn,...props},text);
  const paths={
    chat:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
    link:'M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l2-2',
    users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.9 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    person:'M20 21a8 8 0 0 0-16 0 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    tune:'M4 5h16 M4 12h16 M4 19h16 M8 3v4 M16 10v4 M10 17v4',
    check:'m5 12 4 4L19 6',arrow:'m9 5 7 7-7 7'
  };
  const icon=name=>h('svg',{viewBox:'0 0 24 24',width:18,height:18,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[name]||paths.tune}));
  function Field({label,help,error,children}) {
    const id=React.useId(),control=React.isValidElement(children)&&['input','textarea','select'].includes(children.type);
    return h('div',{className:'qqb-field','data-invalid':error?true:undefined},
      h(control?'label':'span',control?{htmlFor:id}:null,label),
      control?React.cloneElement(children,{id,'aria-invalid':error?true:undefined,'aria-describedby':error||help?id+'-hint':undefined}):children,
      (error||help)&&h('small',{id:id+'-hint',className:error?'qqb-field-error':undefined},error||help));
  }
  const input=(value,onChange,props={})=>h('input',{value:value??'',onChange:e=>onChange(e.target.value),...props});
  const area=(value,onChange,props={})=>h('textarea',{value:value??'',onChange:e=>onChange(e.target.value),rows:3,...props});
  const select=(value,onChange,items)=>h('select',{value,onChange:e=>onChange(e.target.value)},items.map(([v,label])=>h('option',{key:v,value:v},label)));
  const check=(label,value,onChange,props={})=>h('label',{className:'qqb-check'+(props.disabled?' is-disabled':'')},
    h('span',null,h('span',{className:'qqb-toggle-label'},label),props.help&&h('small',null,props.help)),
    h('input',{type:'checkbox',role:'switch','aria-label':label,checked:!!value,disabled:props.disabled,onChange:e=>onChange(e.target.checked)}));
  const field=(label,child,help,error)=>h(Field,{label,help,error},child);
  const heading=(title,name,description)=>h('div',{className:'qqb-section-head'},icon(name),h('div',null,h('h3',null,title),description&&h('p',null,description)));
  const ids=value=>(Array.isArray(value)?value:String(value||'').split(/[\s,，]+/)).map(String).filter(Boolean);
  const idError=value=>ids(value).some(x=>!/^[1-9]\d{3,15}$/.test(x))?'请输入 4–16 位 QQ 号或群号，用换行或逗号分隔。':'';
  function numberError(value,min,max,label) {
    if(value==null||String(value)==='')return label+'不能为空';
    if(!/^\d+$/.test(String(value)))return label+'只能填写整数';
    const n=Number(value);return Number.isSafeInteger(n)&&n>=min&&n<=max?'':label+'须为 '+min+'–'+max;
  }
  function numberField(label,value,change,min,max,help) {
    const error=numberError(value,min,max,label);
    const control=input(value,v=>{if(/^\d*$/.test(v)&&v.length<=String(max).length)change(v);},{
      type:'text',inputMode:'numeric',pattern:'[0-9]*',maxLength:String(max).length,'data-min':min,'data-max':max,
      placeholder:min+'–'+max,onBlur:()=>{if(String(value)!==''&&!error)change(String(Number(value)));}});
    return field(label,control,help,error);
  }
  function urlError(value) {
    try{const u=new URL(value);if(!['ws:','wss:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw 0;
      if(u.port&&Number(u.port)===0)return '端口须为 1–65535';return '';
    }catch{return '请输入有效的 ws:// 或 wss:// 地址，端口须为 1–65535';}
  }
  const numericRules=[['turnTimeout',15,1800,'回复超时'],['sendInterval',500,30000,'发送间隔'],['maxReplyChars',200,4000,'每段字数']];
  function draftSettings(settings) {const s=copy(settings);for(const key of ['reversePort',...numericRules.map(x=>x[0])])s[key]=String(s[key]);return s;}
  function download(name,text,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const recipientCache=new Map();
  function RecipientPicker({data,notify,label,kind='friends',value,onChange,multiple=false,allowedIds}){
    const [open,setOpen]=useState(false),[rows,setRows]=useState([]),[query,setQuery]=useState(''),[loading,setLoading]=useState(false);
    const key=(data.status?.bot||'')+':'+kind,chosen=multiple?ids(value):[String(value||'')].filter(Boolean),scope=allowedIds==null?null:new Set(allowedIds),noun=kind==='groups'?'群':'好友';
    useEffect(()=>{setRows([]);setOpen(false);},[key]);
    const load=async refresh=>{setOpen(true);setLoading(true);try{const cached=recipientCache.get(key);let items;if(!refresh&&cached&&Date.now()-cached.at<60000)items=cached.items;else{items=(await api(kind)).items;recipientCache.set(key,{at:Date.now(),items});}setRows(items);}catch(e){notify(e.message,true);}finally{setLoading(false);}};
    const selectId=id=>onChange(multiple?(chosen.includes(id)?chosen.filter(x=>x!==id):[...new Set([...chosen,id])]):id);
    const filtered=rows.filter(r=>(!scope||scope.has(r.id))&&(r.id+' '+r.name+' '+(r.remark||'')).toLowerCase().includes(query.toLowerCase())).slice(0,100);
    return h('div',{className:'qqb-recipient','data-picker':kind},
      field(label,multiple?area(Array.isArray(value)?value.join('\n'):value,onChange,{rows:2}):input(value,onChange,{inputMode:'numeric'}),'可手动填写，也可从 QQ 选择。',idError(value)),
      h('div',{className:'qqb-row'},button(loading?'正在读取…':'选择'+noun,()=>load(false),{disabled:loading||!data.status?.online}),open&&button('刷新列表',()=>load(true),{disabled:loading}),open&&button('收起',()=>setOpen(false))),
      open&&h('div',null,input(query,setQuery,{type:'search',placeholder:'搜索名称、备注或号码','aria-label':'搜索'+noun}),
        h('div',{className:'qqb-group-list'},filtered.length?filtered.map(r=>h('label',{className:'qqb-group-item',key:r.id},h('input',{type:multiple?'checkbox':'radio',name:label,checked:chosen.includes(r.id),'aria-label':'选择 '+(r.remark||r.name)+' '+r.id,onChange:()=>selectId(r.id)}),h('span',null,r.remark||r.name,h('small',null,r.id)))):h('p',{className:'qqb-empty'},loading?'正在读取…':scope?'没有可选项，先在监听范围中选择群。':'没有匹配项，可手动填写。'))));
  }
  const picker=(data,notify,label,kind,value,onChange,props={})=>h(RecipientPicker,{data,notify,label,kind,value,onChange,...props});
  function Settings({data,act,busy,notify}) {
    const [s,setS]=useState(()=>draftSettings(data.settings)),[token,setToken]=useState(''),[clearToken,setClearToken]=useState(false),
      [groups,setGroups]=useState(null),[loadingGroups,setLoadingGroups]=useState(false),[testing,setTesting]=useState('');
    const set=(key,value)=>setS(old=>({...old,[key]:value}));
    const initial=draftSettings(data.settings),dirty=JSON.stringify(s)!==JSON.stringify(initial)||Boolean(token)||clearToken;
    const errors=[s.mode==='reverse'?numberError(s.reversePort,1024,65535,'监听端口'):urlError(s.url),idError(s.allowedUsers),idError(s.allowedGroups),...numericRules.map(([key,min,max,label])=>numberError(s[key],min,max,label))].filter(Boolean);
    function serialized() {
      const settings={...s};
      settings.reversePort=s.mode==='reverse'||!numberError(s.reversePort,1024,65535,'监听端口')?Number(s.reversePort):data.settings.reversePort;
      if(s.mode==='reverse'&&urlError(s.url))settings.url=data.settings.url;
      for(const [key]of numericRules)settings[key]=Number(s[key]);
      return settings;
    }
    const save=async e=>{e?.preventDefault();if(errors.length){notify(errors[0],true);return;}if(await act('saveSettings',{settings:serialized(),token,clearToken})){setToken('');setClearToken(false);}};
    const test=async()=>{if(errors.length){notify(errors[0],true);return;}setTesting('onebot');try{const result=await api('test',{settings:serialized(),token});notify(result.message+(result.bot?' · QQ '+result.bot+' · '+(result.online?'在线':'离线'):''));}catch(e){notify(e.message,true);}finally{setTesting('');}};
    const testDSH=async()=>{setTesting('dsh');try{const r=await api('selfTest');notify(r.message);}catch(e){notify(e.message,true);}finally{setTesting('');}};
    const loadGroups=async()=>{setLoadingGroups(true);try{setGroups((await api('groups')).items);}catch(e){notify(e.message,true);}finally{setLoadingGroups(false);}};
    const selectedGroups=ids(s.allowedGroups);
    const toggleGroup=(id,on)=>set('allowedGroups',on?[...new Set([...selectedGroups,id])]:selectedGroups.filter(x=>x!==id));
    return h('form',{onSubmit:save,className:'qqb-settings'},
      h('section',{className:'qqb-enable'},check('启用 QQ 桥接',s.enabled,v=>set('enabled',v),{help:s.enabled?'接收并回复允许的 QQ 消息':'已暂停收发 QQ 消息'})),
      h('section',null,heading('连接','link'),
        h('fieldset',{className:'qqb-mode'},h('legend',null,'连接方式'),
          [['forward','正向连接','插件连接 NapCat'],['reverse','反向连接','NapCat 连接插件']].map(([value,label,description])=>h('label',{key:value,className:s.mode===value?'is-selected':''},
            h('input',{type:'radio',name:'onebot-mode',value,checked:s.mode===value,onChange:()=>set('mode',value)}),h('span',null,h('strong',null,label),h('small',null,description))))),
        s.mode==='forward'?field('WebSocket 地址',input(s.url,v=>set('url',v),{placeholder:'ws://127.0.0.1:3001',spellCheck:false,className:'qqb-mono'}),undefined,urlError(s.url)):
          h('div',null,h('div',{className:'qqb-grid'},field('监听地址',select(s.reverseHost,v=>set('reverseHost',v),[['127.0.0.1','127.0.0.1'],['::1','::1']])),
            numberField('监听端口',s.reversePort,v=>set('reversePort',v),1024,65535,'可用范围 1024–65535')),
            field('连接路径',input(s.reversePath,v=>set('reversePath',v),{className:'qqb-mono',placeholder:'/onebot/v11'}))),
        field('Access Token',input(token,setToken,{type:'password',autoComplete:'new-password',placeholder:data.tokenConfigured?'已保存，留空不更改':'填写 NapCat 的 OneBot Token'})),
        h('div',{className:'qqb-row qqb-test-row'},button(testing==='onebot'?'正在连接…':'测试连接',test,{disabled:busy||Boolean(testing)||Boolean(errors.length)}),
          button(testing==='dsh'?'正在测试…':'测试 DSH',testDSH,{disabled:busy||Boolean(testing)})),
        h('details',{className:'qqb-subtle-details'},h('summary',null,'更多连接选项'),check('清除已保存的 Token',clearToken,setClearToken))),
      h('details',{className:'qqb-advanced'},h('summary',null,icon('tune'),h('span',null,'高级设置'),h('small',null,'模型与工作区')),
        h('div',{className:'qqb-advanced-body'},
          field('聊天工作区',input(s.workspacePath,v=>set('workspacePath',v))),
          h('div',{className:'qqb-hint'},'QQ 始终使用框架专用的受限 Agent。可用动作在“主人与权限”中设置。'),
          h('div',{className:'qqb-grid'},field('模型提供方',input(s.provider,v=>set('provider',v),{placeholder:'使用 DSH 默认'})),field('模型 ID',input(s.model,v=>set('model',v),{placeholder:'使用 DSH 默认'}))),
          field('推理强度',select(s.reasoningEffort,v=>set('reasoningEffort',v),[['','模型默认'],['low','低'],['medium','中'],['high','高']])),
          numberField('回复超时',s.turnTimeout,v=>set('turnTimeout',v),15,1800,'秒'))),
      h('div',{className:'qqb-savebar'},h('small',{className:errors.length?'qqb-field-error':undefined},errors[0]|| (dirty?'有未保存的修改':'设置已保存')),
        button(busy?'保存中…':'保存设置',save,{type:'submit',disabled:busy||Boolean(testing)||Boolean(errors.length)||!dirty,className:'qqb-primary'})));
  }
  function promptText(p) {if(typeof p.prompt==='string')return p.prompt;return Object.entries(labels).filter(([k])=>p[k]?.trim()).map(([k,label])=>label+'：\n'+p[k].trim()).join('\n\n');}
  function personaDraft(p={}) {return {name:p.name||'',prompt:promptText(p)};}
  function Personas({data,act,busy,notify}) {
    const [selected,setSelected]=useState(data.personas[0]?.id||''),[draft,setDraft]=useState(()=>personaDraft(data.personas[0])),
      [preview,setPreview]=useState(''),[importText,setImportText]=useState(''),[format,setFormat]=useState('json'),
      [bot,setBot]=useState(data.status?.bot||''),[kind,setKind]=useState('private'),[peer,setPeer]=useState(data.settings.allowedUsers[0]||''),[binding,setBinding]=useState(''),[keep,setKeep]=useState(false),
      [defaultId,setDefaultId]=useState(data.personaDefaults.global),[botDefault,setBotDefault]=useState('');
    const choices=data.personas.map(p=>[p.id,p.name+(p.id===data.personaDefaults.global?' · 默认':'')]);
    const choose=id=>{setSelected(id);setDraft(personaDraft(data.personas.find(p=>p.id===id)));setPreview('');};
    const save=async()=>{const result=await act('savePersona',{id:selected||undefined,persona:draft});if(result){const p=result.personas.find(p=>p.id===selected)||result.personas.at(-1);setSelected(p.id);setDraft(personaDraft(p));}};
    const inspect=async()=>{try{setPreview((await api('preview',{persona:draft,kind})).text);}catch(e){notify(e.message,true);}};
    const rows=[...new Set([...Object.entries(data.sessions).map(([key,s])=>s.chatKey||key),...Object.keys(data.bindings)])];
    const current=data.personas.find(p=>p.id===selected),dirty=JSON.stringify(draft)!==JSON.stringify(personaDraft(current));
    return h('div',null,
      h('section',{className:'qqb-persona-editor'},
        h('div',{className:'qqb-row qqb-persona-picker'},
          h('label',{className:'qqb-sr-only',htmlFor:'qqb-persona-select'},'选择人设'),
          h('select',{id:'qqb-persona-select',value:selected,onChange:e=>choose(e.target.value)},[['','新建人设'],...choices].map(([value,label])=>h('option',{key:value,value},label))),
          button('新建',()=>choose('')),button('复制',()=>{setSelected('');setDraft({...draft,name:(draft.name||'人设')+' 副本'});setPreview('');}),
          selected&&button('删除',async()=>{if(await act('deletePersona',{id:selected}))choose('');},{disabled:busy,className:'qqb-quiet'})),
        field('人设名称',input(draft.name,v=>setDraft(d=>({...d,name:v})),{maxLength:80,placeholder:'给这个人设起个名字'})),
        field('提示词',area(draft.prompt,v=>setDraft(d=>({...d,prompt:v})),{rows:12,maxLength:30000,className:'qqb-prompt',spellCheck:false,placeholder:'例如：你叫小鱼，说话简短自然，喜欢用日常的语气交流……'}),'把角色、语气和回复要求写在这里。'),
        h('div',{className:'qqb-editor-meta'},h('span',null,dirty?'未保存的修改':'下一条消息开始使用'),h('span',null,draft.prompt.length.toLocaleString()+' / 30,000')),
        h('div',{className:'qqb-row qqb-editor-actions'},
          button(busy?'保存中…':'保存人设',save,{disabled:busy||!draft.name.trim()||!draft.prompt.trim(),className:'qqb-primary'}),
          selected&&selected!==data.personaDefaults.global&&button('设为默认',()=>act('setDefault',{id:selected}),{disabled:busy}),
          selected===data.personaDefaults.global&&h('span',{className:'qqb-pill'},icon('check'),'默认人设')),
        h('details',{className:'qqb-subtle-details'},h('summary',null,'预览与导出'),
          h('div',{className:'qqb-row'},button('预览提示词',inspect,{disabled:!draft.name.trim()}),
            button('导出 JSON',()=>download((draft.name||'persona')+'.json',JSON.stringify({schema:2,persona:{...current,...draft}},null,2))),
            button('导出 Markdown',()=>download((draft.name||'persona')+'.md','# '+draft.name+'\n\n'+draft.prompt,'text/markdown'))),
          preview&&h('pre',{className:'qqb-preview'},preview))),
      h('details',{className:'qqb-advanced'},h('summary',null,icon('users'),h('span',null,'为特定聊天指定人设')),
        h('div',{className:'qqb-advanced-body'},
          h('div',{className:'qqb-grid'},field('机器人 QQ',input(bot,setBot)),field('聊天类型',select(kind,v=>{setKind(v);setPeer('');setBinding('');},[['private','私聊'],['group','群聊']])),picker(data,notify,kind==='private'?'对方 QQ':'群号',kind==='private'?'friends':'groups',peer,setPeer)),
          field('使用人设',select(binding,setBinding,[['','跟随默认'],...choices])),
          check('保留当前聊天上下文',keep,setKeep,{help:'关闭时开启新会话，旧记录会保留。'}),
          button('应用绑定',()=>act('bindPersona',{key:bot+':'+kind+':'+peer,id:binding,keepContext:keep}),{disabled:busy}),
          rows.length?h('div',{className:'qqb-table'},h('table',null,h('thead',null,h('tr',null,h('th',null,'聊天'),h('th',null,'人设'),h('th',null,'操作'))),
            h('tbody',null,rows.map(key=>{const [b,k,p]=key.split(':'),id=data.bindings[key]?.personaId||data.personaDefaults.bots[b]||data.personaDefaults.global;
              return h('tr',{key},h('td',null,(k==='group'?'群 ':'QQ ')+p),h('td',null,data.personas.find(p=>p.id===id)?.name||id),
                h('td',null,button('修改',()=>{setBot(b);setKind(k);setPeer(p);setBinding(data.bindings[key]?.personaId||'');}),button('新建上下文',()=>act('resetSession',{key}),{disabled:busy})));})))):null,
          h('div',{className:'qqb-separator'}),h('h4',null,'机器人默认人设'),
          h('div',{className:'qqb-row'},select(defaultId,setDefaultId,choices),input(botDefault,setBotDefault,{placeholder:'机器人 QQ'})),
          button('应用到此机器人',()=>act('setDefault',{id:defaultId,bot:botDefault}),{disabled:busy||!botDefault}),
          Object.entries(data.personaDefaults.bots).map(([b,id])=>h('p',{key:b},'QQ '+b+'：'+(data.personas.find(p=>p.id===id)?.name||id)+' ',button('跟随全局默认',()=>act('clearBotDefault',{bot:b}),{disabled:busy}))))),
      h('details',{className:'qqb-advanced'},h('summary',null,icon('person'),h('span',null,'导入人设')),
        h('div',{className:'qqb-advanced-body'},field('文件格式',select(format,setFormat,[['json','JSON'],['markdown','Markdown']])),
          h('input',{type:'file',accept:'.json,.md,.txt','aria-label':'选择人设文件',onChange:async e=>{const file=e.target.files?.[0];if(file){setImportText(await file.text());setFormat(file.name.endsWith('.json')?'json':'markdown');}}}),
          area(importText,setImportText,{placeholder:'粘贴人设 JSON 或 Markdown',rows:4,'aria-label':'导入内容'}),
          button('导入为新人设',async()=>{if(await act('importPersona',{text:importText,format}))setImportText('');},{disabled:busy||!importText.trim()}))));
  }
  function configDraft(page){
    const result={};for(const [key,f]of Object.entries(page.manifest.configSchema||{})){const value=page.config?.[key]??f.default;result[key]=f.type==='number'?(value===undefined?'':String(value)):f.type==='string[]'?(Array.isArray(value)?value.join('\n'):''):f.type==='boolean'?!!value:value??'';}return result;
  }
  function configValue(page,draft){
    const value={},errors={};for(const [key,f]of Object.entries(page.manifest.configSchema||{})){
      const raw=draft[key];let v=raw;
      if(f.type==='number'){
        if(String(raw).trim()===''){if(f.default===undefined&&!f.required)continue;errors[key]='请填写'+(f.title||key);continue;}
        if(!/^-?\d+(?:\.\d+)?$/.test(String(raw))||!Number.isFinite(Number(raw))||f.integer&&!Number.isInteger(Number(raw))){errors[key]='请填写有效'+(f.integer?'整数':'数字');continue;}
        v=Number(raw);if(f.min!=null&&v<f.min||f.max!=null&&v>f.max)errors[key]='可用范围 '+(f.min??'不限')+'–'+(f.max??'不限');
      }else if(f.type==='string[]'){
        v=String(raw).split(/[\n,，]+/).map(s=>s.trim()).filter(Boolean);
        if(v.length>(f.maxItems||100)||f.format==='qq'&&idError(v))errors[key]='列表格式或数量无效';
      }else if(f.type==='string'&&(f.required&&!String(raw).trim()||String(raw).length>(f.maxLength||20000)))errors[key]='请检查'+(f.title||key)+'的长度';
      value[key]=v;
    }return {value,errors};
  }
  function PluginSettings({page,data,act,busy,notify}){
    const [draft,setDraft]=useState(()=>configDraft(page)),[enabled,setEnabled]=useState(page.enabled),[scope,setScope]=useState(()=>copy(page.scope||{private:true,users:data.settings.allowedUsers,groups:[]})),
      [grants,setGrants]=useState(page.automationGrants||[]),[view,setView]=useState(null),[loading,setLoading]=useState(false),[groupId,setGroupId]=useState(''),[offset,setOffset]=useState(0);
    const schema=page.manifest.configSchema||{},parsed=configValue(page,draft),set=(key,value)=>setDraft(old=>({...old,[key]:value}));
    const sections=page.sections?.length?page.sections:[{title:'设置',fields:Object.keys(schema)}],used=new Set(sections.flatMap(s=>s.fields)),extra=Object.keys(schema).filter(k=>!used.has(k));
    const allSections=extra.length?[...sections,{title:'其他设置',fields:extra}]:sections;
    const errors=[...Object.values(parsed.errors),idError(scope.users),...ids(scope.groups).some(g=>!data.framework.listenGroups.includes(g))?['生效群必须在核心监听范围内']:[]].filter(Boolean);
    const changeGroup=(id,on)=>setScope(s=>({...s,groups:on?[...new Set([...ids(s.groups),id])]:ids(s.groups).filter(g=>g!==id)}));
    const load=async()=>{setLoading(true);try{setView(await api('pluginPageData',{id:page.id,native:page.native,query:{groupId,offset}}));}catch(error){notify(error.message,true);}finally{setLoading(false);}};
    useEffect(()=>{void load();const timer=setInterval(()=>void load(),10000);return()=>clearInterval(timer);},[page.id,groupId,offset]);
    const save=()=>{const automationGrants=(page.manifest.automations||[]).filter(a=>a.configGate?parsed.value[a.configGate]===true:grants.includes(a.id)).map(a=>a.id);
      act(page.native?'configureNativePackage':'configureExtension',{id:page.id,config:parsed.value,enabled,scope,automationGrants});};
    function renderField(key){
      const f=schema[key];if(!f)return null;const label=f.title||key,help=f.description;
      if(f.type==='boolean')return h('div',{key},check(label,draft[key],v=>set(key,v),{help}));
      const control=f.type==='number'?input(draft[key],v=>{if(/^-?\d*(?:\.\d*)?$/.test(v))set(key,v);},{inputMode:f.integer?'numeric':'decimal',placeholder:f.min!=null&&f.max!=null?f.min+'–'+f.max:undefined}):
        f.enum?select(draft[key],v=>set(key,v),f.enum.map(v=>[v,v])):f.type==='string[]'||f.multiline?area(draft[key],v=>set(key,v),{rows:3,maxLength:f.maxLength||20000}):input(draft[key],v=>set(key,v),{maxLength:f.maxLength||20000});
      return h(Field,{key,label,help:help||(f.type==='number'&&f.min!=null&&f.max!=null?'范围 '+f.min+'–'+f.max:undefined),error:parsed.errors[key]},control);
    }
    const groupChoices=[...new Set([...data.framework.listenGroups,...ids(scope.groups)])];
    const exportCsv=()=>{const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};const columns=view.columns||[];const text='\uFEFF'+[columns.map(c=>cell(c.label)).join(','),...(view.rows||[]).map(row=>columns.map(c=>cell(row[c.key])).join(','))].join('\r\n');download(page.id+'.csv',text,'text/csv;charset=utf-8');};
    return h('div',{className:'qqb-plugin-page'},
      h('div',{className:'qqb-section-head'},icon('tune'),h('div',null,h('h3',null,page.title),h('p',null,page.description)),h('span',{className:'qqb-pill'},page.enabled?'已启用':'已停用')),
      page.error&&h('div',{className:'qqb-hint qqb-error'},page.error),
      page.health?.quarantined&&h('div',{className:'qqb-hint qqb-warning'},'此插件连续异常，已单独停用。修复设置后可重新启用。'),
      page.dependencyProblems?.length>0&&h('div',{className:'qqb-hint qqb-warning'},page.dependencyProblems.join('；')),
      h('section',null,check('启用此插件',enabled,setEnabled)),
      allSections.filter(s=>s.fields.length).map(section=>h('section',{key:section.title},heading(section.title,'tune'),section.fields.map(renderField))),
      h('section',null,heading('作用范围','users','这里控制插件的数据与触发范围；AI 动作仍需在“主人与权限”单独批准。'),
        picker(data,notify,'生效群','groups',scope.groups,v=>setScope(s=>({...s,groups:v})),{multiple:true,allowedIds:data.framework.listenGroups}),
        check('允许私聊调用',scope.private,v=>setScope(s=>({...s,private:v}))),
        field('插件适用用户',select(scope.allUsers?'all':'selected',v=>setScope(s=>({...s,allUsers:v==='all'})),[['all','所有聊天用户'],['selected','指定 QQ']])),
        !scope.allUsers&&picker(data,notify,'插件用户 QQ','friends',scope.users,v=>setScope(s=>({...s,users:v})),{multiple:true}),
        (page.manifest.automations||[]).filter(a=>!a.configGate).map(a=>check(a.title,grants.includes(a.id),v=>setGrants(old=>v?[...old,a.id]:old.filter(id=>id!==a.id)),{help:'允许该规则在生效群自动回复，不经过 AI。'})),
        (page.manifest.automations||[]).some(a=>a.configGate)&&h('small',null,'开启自动欢迎并保存，即授权该规则在所选群发送固定文字；每个群每分钟最多 3 次。')),
      h('div',{className:'qqb-savebar'},h('small',{className:errors.length?'qqb-field-error':undefined},errors[0]||'保存后旧执行身份会撤销。'),button('保存插件设置',save,{disabled:busy||errors.length>0,className:'qqb-primary'})),
      page.settingsHistory?.length>0&&h('details',{className:'qqb-advanced'},h('summary',null,'设置历史'),h('div',{className:'qqb-advanced-body'},page.settingsHistory.map((item,index)=>h('div',{key:index,className:'qqb-reason'},h('small',null,new Date(item.at).toLocaleString()+' · 配置版本 '+item.configVersion),button('恢复这次设置',()=>act('restorePluginSettings',{id:page.id,native:page.native,index}),{disabled:busy}))),h('small',null,'恢复后先保持停用，确认配置后再启用。'))),
      view&&(view.columns?.length||view.stats?.length)?h('section',null,heading('运行数据','users'),
        h('div',{className:'qqb-status-grid'},(view.stats||[]).map((s,i)=>h('div',{key:i,className:'qqb-stat'},h('strong',null,String(s.value)),h('small',null,s.label)))),
        h('div',{className:'qqb-row'},view.groups&&select(groupId,v=>{setGroupId(v);setOffset(0);},[['','全部生效群'],...view.groups.map(g=>[g,'群 '+g])]),button(loading?'刷新中…':'刷新记录',load,{disabled:loading}),button('导出当前页',exportCsv,{disabled:!view.rows?.length})),
        view.rows?.length?h('div',{className:'qqb-table'},h('table',null,h('thead',null,h('tr',null,(view.columns||[]).map(c=>h('th',{key:c.key},c.label)))),h('tbody',null,view.rows.map((row,i)=>h('tr',{key:i},view.columns.map(c=>h('td',{key:c.key},c.format==='datetime'&&Number.isFinite(Date.parse(row[c.key]))?new Date(row[c.key]).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):String(row[c.key]??'')))))))):h('p',{className:'qqb-empty'},'暂无记录。选择群并启用插件后，新的成员变化会出现在这里。'),
        h('div',{className:'qqb-row'},button('上一页',()=>setOffset(Math.max(0,offset-30)),{disabled:offset===0||loading}),h('small',null,'共 '+(view.total??view.rows?.length??0)+' 条'),button('下一页',()=>setOffset(offset+30),{disabled:!view.hasMore||loading}))):null);
  }
  function UninstallWizard({target,data,act,onClose}){
    const [choice,setChoice]=useState('keep'),[plan,setPlan]=useState(null),[working,setWorking]=useState(false),[error,setError]=useState('');const ref=React.useRef(null),title=React.useId();
    const cancel=async()=>{if(working)return;if(plan)await api('cancelUninstall',{ticket:plan.ticket}).catch(()=>{});onClose();};
    const cancelRef=React.useRef(cancel);cancelRef.current=cancel;
    useEffect(()=>{const old=document.activeElement,escape=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();void cancelRef.current();}};document.addEventListener('keydown',escape,true);ref.current?.querySelector('input,button')?.focus();return()=>{document.removeEventListener('keydown',escape,true);if(old?.isConnected)old.focus();};},[]);
    const next=async()=>{setWorking(true);setError('');try{setPlan(await api('prepareUninstall',{kind:target.kind,id:target.id,configChoice:choice,revision:data.revision}));}catch(e){setError(e.message);}finally{setWorking(false);}};
    const back=async()=>{if(plan)await api('cancelUninstall',{ticket:plan.ticket}).catch(()=>{});setPlan(null);setError('');};
    const confirm=async()=>{setWorking(true);const result=await act('confirmUninstall',{ticket:plan.ticket,confirmed:true,revision:plan.revision});setWorking(false);if(result)onClose();else setError('未能确认卸载结果。请返回上一步，刷新状态后重新确认。');};
    return h('div',{className:'qqb qqb-uninstall-overlay'},h('div',{ref,role:'alertdialog','aria-modal':true,'aria-labelledby':title,className:'qqb-uninstall-dialog',onKeyDown:e=>{if(e.key==='Escape'){e.stopPropagation();void cancel();}if(e.key==='Tab'){const nodes=[...ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}},
      h('h3',{id:title},plan?'再次确认卸载':'卸载 '+target.name),h('small',null,plan?'第 2 步，共 2 步':'第 1 步，共 2 步'),
      plan?h('div',null,h('p',null,plan.name+' · '+plan.version),h('p',null,'配置处理：'+(plan.configChoice==='keep'?'保留配置':'删除配置')),
        plan.clear.length?h('div',{className:'qqb-hint qqb-warning'},h('strong',null,'将清理'),plan.clear.map((text,i)=>h('p',{key:i},text))):h('p',null,'当前配置与设置历史保留，重新安装后可继续使用。'),
        h('div',{className:'qqb-hint'},h('strong',null,'将保留'),plan.retained.map((text,i)=>h('p',{key:i},text))),plan.hostNote&&h('p',null,plan.hostNote),
        plan.configChoice==='delete'&&h('p',{className:'qqb-error'},'被清理的设置不能通过插件的设置历史恢复。')):
        h('div',null,h('p',null,'卸载后停止此插件的功能，保留包文件以便重新安装。只处理已保存的配置，未保存的修改不会保留。'),h('fieldset',null,h('legend',null,'如何处理配置'),
          h('label',{className:'qqb-uninstall-choice'},h('input',{type:'radio',name:'uninstall-config',value:'keep',checked:choice==='keep',onChange:()=>setChoice('keep')}),h('span',null,'保留配置',h('small',null,'推荐。重新安装后继续使用原设置。'))),
          h('label',{className:'qqb-uninstall-choice'},h('input',{type:'radio',name:'uninstall-config',value:'delete',checked:choice==='delete',onChange:()=>setChoice('delete')}),h('span',null,'删除配置',h('small',null,'下一步会列出具体清理项。'))))),
      error&&h('p',{role:'alert',className:'qqb-error'},error),h('div',{className:'qqb-uninstall-actions'},button('取消',cancel,{disabled:working}),plan?button('返回修改',back,{disabled:working}):null,button(working?'处理中…':plan?'确认卸载':'下一步，查看确认',plan?confirm:next,{disabled:working,className:plan?'qqb-danger':'qqb-primary'}))));
  }

  function ExtensionCard({item,act,busy,onSettings}){
    const [enabled,setEnabled]=useState(item.enabled),m=item.manifest,uninstall=React.useContext(UninstallContext);
    return h('section',null,h('div',{className:'qqb-row'},h('h3',null,m.name),h('span',{className:'qqb-pill'},m.version+' · '+(item.uninstalled?'未安装':item.enabled?'已启用':'已停用'))),
      h('p',null,m.description),h('small',null,m.id+(item.native?' · 原生功能包':' · 声明式包')),
      item.error&&h('p',{className:'qqb-error'},item.error),
      item.health?.quarantined&&h('div',{className:'qqb-hint qqb-warning'},'连续异常，已隔离此插件；核心仍正常运行。'),
      item.dependencyProblems?.length>0&&h('small',{className:'qqb-error'},item.dependencyProblems.join('；')),
      Object.keys(m.dependencies||{}).length>0&&h('small',null,'依赖：'+Object.entries(m.dependencies).map(([id,v])=>id+' '+v).join('、')),
      !item.uninstalled&&check('启用此扩展',enabled,setEnabled),
      h('div',{className:'qqb-row'},
        !item.uninstalled&&button('打开设置',onSettings,{disabled:!onSettings,className:'qqb-primary'}),
        !item.uninstalled&&button('保存启停',()=>act(item.native?'configureNativePackage':'configureExtension',{id:m.id,config:item.config,scope:item.scope,automationGrants:item.automationGrants||[],enabled}),{disabled:busy}),
        item.uninstalled?button('重新安装',()=>act('restorePackage',{kind:item.native?'native':'extension',id:m.id}),{disabled:busy}):button(item.native&&!m.bundled?'移除 QQ 功能':'卸载包',()=>uninstall({kind:item.native?'native':'extension',id:m.id,name:m.name}),{disabled:busy,className:'qqb-quiet'})),
      item.history?.length>0&&h('details',{className:'qqb-subtle-details'},h('summary',null,'历史版本与回滚'),h('small',null,'回滚保留当时的配置，完成后需重新启用。'),item.history.map(p=>h('div',{key:p.generation,className:'qqb-reason'},h('small',null,p.manifest.version+' · '+new Date(p.installedAt).toLocaleString()),button('回滚到 '+p.manifest.version,()=>act('rollbackExtension',{id:m.id,generation:p.generation}),{disabled:busy})))));
  }
  function Plugins({data,act,busy,notify}){
    const [pageId,setPageId]=useState(null),[tab,setTab]=useState('installed'),[catalog,setCatalog]=useState(null),[query,setQuery]=useState(''),[sources,setSources]=useState(()=>copy(data.sources));
    const refresh=async()=>{try{setCatalog(await api('catalog'));}catch(e){notify(e.message,true);}};
    useEffect(()=>{if(tab==='market')void refresh();},[tab]);
    const page=(data.pluginPages||[]).find(p=>p.id===pageId&&!p.uninstalled);
    if(pageId&&page)return h('div',null,button('返回插件列表',()=>setPageId(null),{className:'qqb-quiet'}),h(PluginSettings,{key:page.id+'-'+data.revision,page,data,act,busy,notify}));
    return h('div',null,h('div',{className:'qqb-tabs'},button('已安装',()=>setTab('installed'),{'aria-pressed':tab==='installed'}),data.framework.builtins.market.enabled&&button('插件市场',()=>setTab('market'),{'aria-pressed':tab==='market'})),
      tab==='installed'?h('div',null,h('p',null,'核心始终保留 QQ 对接、主人管理与受限 Agent。功能包可独立启停。'),
        data.builtins.map(item=>h(BuiltinCard,{key:item.id+'-'+data.revision,item,act,busy,data,notify})),
        h('h3',null,'功能扩展'),
        (data.nativePackages||[]).map(item=>h(ExtensionCard,{key:'native-'+item.manifest.id+'-'+data.revision,item,act,busy,onSettings:()=>setPageId(item.manifest.id)})),
        data.extensions.length?data.extensions.map(item=>h(ExtensionCard,{key:item.manifest.id+'-'+item.generation+'-'+data.revision,item,act,busy,onSettings:()=>setPageId(item.manifest.id)})):h('section',null,h('p',null,'尚未安装功能扩展。可在插件市场安装“帮助命令”或“关键词回复”。'),button('打开插件市场',()=>setTab('market')))):
      h('div',null,h('p',null,'市场支持声明式规则包。安装、启用与 AI 执行授权分别管理。'),
        h('div',{className:'qqb-row'},input(query,setQuery,{placeholder:'搜索扩展'}),button('刷新 / 检查更新',refresh)),
        catalog?.errors.map(e=>h('p',{key:e.source,className:'qqb-error'},e.source+'：'+e.error)),
        (catalog?.items||[]).filter(m=>(m.name+' '+m.id+' '+m.description).toLowerCase().includes(query.toLowerCase())).map(m=>{
          const installed=data.extensions.find(e=>e.manifest.id===m.id);
          return h('section',{key:m.source+':'+m.id+':'+m.version},h('div',{className:'qqb-row'},h('h3',null,m.name),h('span',{className:'qqb-pill'},m.version)),
            h('p',null,m.description),h('p',null,'权限：'+m.capabilities.join('、')),h('small',null,'来源：'+(m.source==='builtin'?'内置示例市场':m.source)+' · 扩展 API '+m.hostApiVersion),
            h('details',null,h('summary',null,'查看校验与兼容信息'),h('code',null,'SHA-256: '+m.sha256),h('p',null,'ID: '+m.id+' · DSH 0.2.1-rc.2')),
            button(installed?.uninstalled?'重新安装':installed?(installed.manifest.version===m.version?'已安装':'更新至 '+m.version):'安装',()=>act('installExtension',{id:m.id,version:m.version,source:m.source}),{disabled:busy||!!installed&&!installed.uninstalled&&installed.manifest.version===m.version}));
        }),
        h('section',null,h('h3',null,'市场源'),h('p',null,'添加自己的本地或 HTTPS 市场索引。'),
          sources.map((source,i)=>h('div',{className:'qqb-source',key:i},
            input(source.name,v=>setSources(old=>old.map((s,n)=>n===i?{...s,name:v}:s)),{placeholder:'市场名称'}),
            select(source.kind,v=>setSources(old=>old.map((s,n)=>n===i?{...s,kind:v}:s)),[['local','本地索引'],['https','HTTPS 索引']]),
            input(source.location,v=>setSources(old=>old.map((s,n)=>n===i?{...s,location:v}:s)),{placeholder:source.kind==='local'?'F:\\路径\\index.json':'https://example.com/index.json'}),
            button('移除',()=>setSources(old=>old.filter((_,n)=>n!==i))))),
          h('div',{className:'qqb-row'},button('添加市场源',()=>setSources(old=>[...old,{name:'我的市场',kind:'local',location:''}])),button('保存市场源',()=>act('saveSources',{sources}),{disabled:busy})))));
  }
  function Conversations({data,act,busy,notify}){
    const [s,setS]=useState(()=>({...draftSettings(data.settings),botAliases:(data.settings.botAliases||[]).join('\n')})),[groups,setGroups]=useState(null),[loading,setLoading]=useState(false);
    const set=(k,v)=>setS(old=>({...old,[k]:v})),errors=[numberError(s.intentPerMinute??12,1,30,'每分钟意图判断'),numberError(s.intentPerHour??180,1,600,'每小时意图判断'),numberError(s.actionTextProbability??30,0,100,'动作描写概率'),numberError(s.interjectionProbability??30,0,100,'语气词概率'),idError(s.allowedUsers),idError(s.allowedGroups),numberError(s.sendInterval,500,30000,'分条间隔'),numberError(s.maxReplyChars,200,4000,'每条最多字数'),numberError(s.replyTotalChars??240,80,4000,'每轮总字数'),numberError(s.followupWindowSec??120,15,300,'续聊等待时长'),numberError(s.followupMaxTurns??8,1,20,'每次最多续聊'),numberError(s.pokeReplyCooldown??30,5,600,'戳一戳冷却'),numberError(s.replyMaxParts??2,1,6,'每轮最多条数'),numberError(s.groupReplyProbability??10,0,100,'随机回复概率'),numberError(s.groupReplyCooldown??30,0,600,'随机回复冷却')].filter(Boolean);
    const save=async e=>{e?.preventDefault();if(errors.length)return;await act('saveConversation',{settings:{...s,intentPerMinute:Number(s.intentPerMinute??12),intentPerHour:Number(s.intentPerHour??180),actionTextProbability:Number(s.actionTextProbability??30),interjectionProbability:Number(s.interjectionProbability??30),sendInterval:Number(s.sendInterval),maxReplyChars:Number(s.maxReplyChars),replyTotalChars:Number(s.replyTotalChars??240),replyMaxParts:Number(s.replyMaxParts??2),followupWindowSec:Number(s.followupWindowSec??120),followupMaxTurns:Number(s.followupMaxTurns??8),pokeReplyCooldown:Number(s.pokeReplyCooldown??30),groupReplyProbability:Number(s.groupReplyProbability??10),groupReplyCooldown:Number(s.groupReplyCooldown??30),groupAutoLimit:Number(s.groupAutoLimit??2),botAliases:String(s.botAliases||'').split(/[\n,，]+/).map(v=>v.trim()).filter(Boolean)}});};
    const load=async()=>{setLoading(true);try{setGroups((await api('groups')).items);}catch(e){notify(e.message,true);}finally{setLoading(false);}};
    return h('form',{onSubmit:save},
      h('section',null,heading('谁可以聊天','users','聊天资格与工具权限分开设置。这里保存时会同步相应的私聊监听范围。'),
        check('允许私聊',s.privateEnabled,v=>set('privateEnabled',v)),
        field('私聊用户',select(s.privateAudience||'allowlist',v=>set('privateAudience',v),[['all','所有私聊用户'],['allowlist','仅指定 QQ']])),
        check('允许群聊',s.groupEnabled,v=>set('groupEnabled',v)),
        field('群内聊天用户',select(s.groupAudience||'allowlist',v=>set('groupAudience',v),[['all','所选群的所有成员'],['allowlist','仅指定 QQ']])),
        (s.privateAudience!=='all'||s.groupAudience!=='all')&&picker(data,notify,'指定用户 QQ','friends',s.allowedUsers,v=>set('allowedUsers',v),{multiple:true}),
        h('div',{className:'qqb-hint'},'其他人可以正常提问。工具在“主人与权限”中单独开放，聊天不会授予电脑或服务器操作权限。')),
      h('section',null,heading('群聊','chat'),
        h('div',{className:'qqb-hint'},'同群成员共用最近的公开聊天背景；工具执行按当前发言者隔离，私聊不会混入群聊。'),
        field('群聊参与方式',select(s.groupReplyMode||'smart',v=>set('groupReplyMode',v),[['direct','只在被叫时回复'],['smart','适度参与'],['all',s.intentRecognition!==false?'逐条分析是否回应':'每条消息都回复']])),
        h('small',null,'@ 或引用她的消息可直接唤醒。未 @ 时先辨认交流对象；在叫她时正常回应，只是群友交谈则旁听。与她相关但并非在问她的话题，仍受参与概率和冷却限制。'),
        check('识别没有 @ 的呼唤和交流意图',s.intentRecognition!==false,v=>set('intentRecognition',v),{help:'结合称呼、人设自称及近期上下文判断；续聊也要判断，不会因为主人发言就抢答。只判断、不调用工具；会消耗模型用量。'}),
        h('details',null,h('summary',null,'意图判断用量'),h('div',{className:'qqb-grid'},numberField('每分钟意图判断',s.intentPerMinute??12,v=>set('intentPerMinute',v),1,30,'次／群；达到上限继续旁听'),numberField('每小时意图判断',s.intentPerHour??180,v=>set('intentPerHour',v),1,600,'次／群'))),
        field('机器人称呼',area(s.botAliases,v=>set('botAliases',v),{rows:2}),'每行一个，可补充“小鱼”等常用昵称。也会参考当前人设中的自称；名字不必放在句首。'),
        check('允许连续交谈',s.followupEnabled!==false,v=>set('followupEnabled',v),{help:'被叫到或戳一戳后，同一人不用每条 @。每次实际回复延长等待；不同成员分别计数，单次交谈最长 10 分钟。'}),
        h('div',{className:'qqb-grid'},numberField('续聊等待时长',s.followupWindowSec??120,v=>set('followupWindowSec',v),15,300,'秒；每次实际回复后重新等待'),numberField('每次最多续聊',s.followupMaxTurns??8,v=>set('followupMaxTurns',v),1,20,'轮；再次被叫到可开启新的交谈')),
        s.groupReplyMode==='smart'&&h('div',{className:'qqb-grid'},numberField('随机回复概率',s.groupReplyProbability??10,v=>set('groupReplyProbability',v),0,100,'%'),numberField('随机回复冷却',s.groupReplyCooldown??30,v=>set('groupReplyCooldown',v),0,600,'秒'),numberField('每分钟随机回复上限',s.groupAutoLimit??2,v=>set('groupAutoLimit',v),1,10,'每群')),
        picker(data,notify,'允许回复的群','groups',s.allowedGroups,v=>set('allowedGroups',v),{multiple:true}),
        !s.groupEnabled&&h('div',{className:'qqb-hint'},'群回复当前关闭，@机器人也不会触发。')),
      h('p',{className:'qqb-hint'},'戳一戳互动已独立为内置包，在“插件”中配置。'),
      h('section',null,heading('表达习惯','chat','允许出现不等于每次都要出现；概率按每轮交谈抽取，不对每个词反复抽签。'),
        field('动作描写',select(s.actionTextMode||'allow',v=>set('actionTextMode',v),[['allow','交给她自然表达'],['off','不发送动作描写'],['probability','按概率允许']])),
        s.actionTextMode==='probability'&&numberField('动作描写概率',s.actionTextProbability??30,v=>set('actionTextProbability',v),0,100,'%'),
        field('语气词',select(s.interjectionMode||'allow',v=>set('interjectionMode',v),[['allow','交给她自然表达'],['off','少用独立语气词'],['probability','按概率允许']])),
        s.interjectionMode==='probability'&&numberField('语气词概率',s.interjectionProbability??30,v=>set('interjectionProbability',v),0,100,'%'),
        h('small',null,'允许时保留完整动作及括号；关闭时要求模型直接表达，并整体过滤明确的动作片段，不会只删括号。正常解释和数学括号保留。')),
      h('section',null,heading('回复方式','chat'),
        field('引用原消息',select(s.replyQuoteMode||'off',v=>set('replyQuoteMode',v),[['off','不附引用框'],['follow','只在用户引用提问时'],['always','每次都引用']])),
        h('small',null,'默认直接发消息，像正常群聊一样；你发来的引用仍会被读取。'),
        field('分条发送',select(s.replySplit||'natural',v=>set('replySplit',v),[['natural','自然分条（短句换行分开发）'],['paragraphs','按段落分条'],['length','按字数分条'],['single','整段发送，过长时自动拆分']])),
        h('small',null,s.replySplit==='natural'?'短句之间的换行会分成独立气泡；列表和代码保留整体。超过条数上限时只合并尾部。':s.replySplit==='paragraphs'?'只按空行分段，单次换行保留在同一条消息里。':'根据选择拆分文字；每条发送前都会重新检查权限。'),
        h('div',{className:'qqb-grid'},numberField('每轮总字数',s.replyTotalChars??240,v=>set('replyTotalChars',v),80,4000,'整轮文字上限，包含工具发送'),numberField('每轮最多条数',s.replyMaxParts??2,v=>set('replyMaxParts',v),1,6,'包含工具发送和最终回复')),
        h('div',{className:'qqb-grid'},numberField('每条最多字数',s.maxReplyChars,v=>set('maxReplyChars',v),200,4000,'按段落或字数分条时使用'),numberField('分条间隔',s.sendInterval,v=>set('sendInterval',v),500,30000,'毫秒，避免连续刷屏'))),
      h('div',{className:'qqb-savebar'},h('small',{className:errors.length?'qqb-field-error':undefined},errors[0]||'保存不会断开 QQ 网关。'),button('保存聊天设置',save,{disabled:busy||!!errors.length,className:'qqb-primary'})));
  }

  const phaseName={collecting:'等补充',ready:'准备中',deciding:'判断是否接话',observing:'继续观察',responding:'交谈中',replied:'已回应',merged:'已合并',silent:'旁听',failed:'未完成'};
  function Activity({data,chatKey}){
    const rows=(data.participation?.activity||[]).filter(r=>!chatKey||r.key===chatKey).slice(0,16);
    return h('section',null,heading('最近活动','chat'),rows.length?rows.map((r,i)=>h('div',{className:'qqb-activity',key:r.at+'-'+i},h('span',{className:'qqb-pill'},phaseName[r.state]||r.state),h('div',null,h('strong',null,r.label),h('small',null,(r.kind==='group'?'群 ':'好友 ')+r.peer+' · '+new Date(r.at).toLocaleTimeString())))):h('p',{className:'qqb-empty'},'收到消息后，这里会说明她为什么接话或保持安静。'));
  }
  function Overview({data,navigate}){
    const active=data.participation?.rooms||[],persona=data.personas.find(p=>p.id===data.personaDefaults.global)?.name||'基础助手';
    return h('div',null,h('section',{className:'qqb-overview-hero'},h('small',null,'当前账号'),h('h3',null,data.status?.nickname||'等待 QQ 连接'),h('p',null,data.status?.online?'QQ 在线，可以接收消息。':'请先连接 NapCat，再选择要聊天的群或好友。'),h('div',{className:'qqb-row'},button('管理聊天对象',()=>navigate('rooms'),{className:'qqb-primary'}),button('查看活动',()=>navigate('activity')))),
      h('div',{className:'qqb-overview-stats'},[['当前人设',persona],['接收消息的群',data.framework.listenGroups.length],['正在处理',active.length]].map(([label,value])=>h('section',{key:label},h('small',null,label),h('strong',null,value)))),
      active.length?h('section',null,heading('正在参与的聊天','chat'),active.map(r=>h('div',{className:'qqb-activity',key:r.id||r.key+r.user},h('span',{className:'qqb-pill'},phaseName[r.phase]||r.phase),h('div',null,r.key.split(':')[2],h('small',null,r.messageCount+' 条连续消息'))))):null,h(Activity,{data}));
  }
  function ChatObjects({data,act,busy,notify,navigate,dirty,onClean}){
    const [kind,setKind]=useState('group'),[peer,setPeer]=useState(data.framework.listenGroups[0]||''),[details,setDetails]=useState(null),[draft,setDraft]=useState(null),[listening,setListening]=useState(false),[personaId,setPersonaId]=useState(''),[loading,setLoading]=useState(false),[pendingRoom,setPendingRoom]=useState(null);
    const loadSequence=React.useRef(0),chooseRoom=(nextKind,nextPeer)=>{if(dirty){setPendingRoom({kind:nextKind,peer:nextPeer});return;}setKind(nextKind);setPeer(nextPeer);};
    const key=(data.status?.bot||'')+':'+kind+':'+peer;
    const load=async()=>{const sequence=++loadSequence.current;setLoading(true);try{const d=await api('chatDetails',{key});if(sequence!==loadSequence.current)return;setDetails(d);setListening(d.listening);setPersonaId(d.personaId);setDraft({replyEnabled:d.profile.replyEnabled!==false,decisionEnabled:d.profile.decisionEnabled??data.settings.decisionEnabled!==false,participation:d.profile.participation||'inherit',audience:d.profile.audience||'inherit',users:d.profile.users||[],environment:d.profile.environment||'',mergeWindowMs:String(d.profile.mergeWindowMs??data.settings.mergeWindowMs??1200),maxCollectMs:String(d.profile.maxCollectMs??data.settings.maxCollectMs??5000),staleAfterSec:String(d.profile.staleAfterSec??data.settings.staleAfterSec??60)});}catch(e){setDetails(null);setDraft(null);notify(e.message,true);}finally{setLoading(false);}};
    useEffect(()=>{setDetails(null);setDraft(null);if(data.status?.bot&&/^\d{4,16}$/.test(peer))void load();return()=>{loadSequence.current++;};},[key]);
    const set=(k,v)=>setDraft(d=>({...d,[k]:v})),errors=draft?[numberError(draft.mergeWindowMs,0,5000,'连续消息等待'),numberError(draft.maxCollectMs,1000,10000,'最长等待'),numberError(draft.staleAfterSec,15,180,'旧回复有效期'),idError(draft.users)].filter(Boolean):[];
    const save=async()=>{const result=await act('saveChatProfile',{revision:details.revision,key,listening,personaId,profile:{...draft,users:ids(draft.users),mergeWindowMs:Number(draft.mergeWindowMs),maxCollectMs:Number(draft.maxCollectMs),staleAfterSec:Number(draft.staleAfterSec)}});if(result)await load();};
    const rules=data.framework.grants.filter(g=>!g.deny&&(kind==='group'?g.groups.includes(peer):g.private&&(g.allUsers||g.users.includes(peer))));
    return h('div',null,h('section',null,heading('聊天对象','users','选一个群或好友，在这里安排她如何参与。'),h('div',{'data-browse':true},field('聊天类型',select(kind,v=>chooseRoom(v,''),[['group','群聊'],['private','私聊']])),picker(data,notify,kind==='group'?'选择群':'选择好友',kind==='group'?'groups':'friends',peer,v=>chooseRoom(kind,v)))),
      pendingRoom?h('div',{className:'qqb-notice',role:'status'},'当前聊天还有未保存修改。',button('继续编辑',()=>setPendingRoom(null)),button('放弃并选择其他聊天',()=>{onClean();setKind(pendingRoom.kind);setPeer(pendingRoom.peer);setPendingRoom(null);})):null,
      loading?h('p',{role:'status'},'正在读取聊天设置…'):draft&&details?h('div',null,
      h('section',null,heading(kind==='group'?'群 '+peer:'好友 '+peer,'chat'),h('div',{className:'qqb-row'},h('span',{className:'qqb-pill'},listening?'接收消息':'未接收'),h('span',{className:'qqb-pill'},details.replyReason?'尚有回复限制':draft.replyEnabled?'允许聊天':'暂停聊天'),h('span',{className:'qqb-pill'},'人设：'+details.resolvedPersona)),
        details.replyReason?h('small',null,'当前限制：'+({'bridge-disabled':'连接已停用','group-disabled':'全局群聊未开启','group-not-allowed':'此群不在回复范围','private-disabled':'全局私聊未开启','user-not-allowed':'当前用户不在聊天成员范围',paused:'机器人已暂停','chat-disabled':'AI 聊天包已停用'}[details.replyReason]||details.replyReason)):null,
        check('接收这里的消息',listening,setListening,{disabled:kind==='private'&&ownerIds(data.framework).includes(peer),help:'接收消息用于聊天背景和已启用的功能包。'}),check('在这里聊天',draft.replyEnabled,v=>set('replyEnabled',v),{help:'暂停聊天不会关闭主人的核心管理。'}),
        kind==='group'?field('参与方式',select(draft.participation,v=>set('participation',v),[['inherit','跟随全局设置'],['direct','被叫到时参与'],['smart','自然参与'],['all',data.settings.intentRecognition!==false?'逐条分析是否回应':'逐条回应']])):null,
        field('可以和谁聊天',select(draft.audience,v=>set('audience',v),[['inherit','跟随全局范围'],['all','这里的所有成员'],['selected','指定成员']])),draft.audience==='selected'?picker(data,notify,'聊天成员','friends',draft.users,v=>set('users',v),{multiple:true}):null,
        data.framework.builtins.persona.enabled?field('使用人设',select(personaId,setPersonaId,[['','跟随默认'],...data.personas.map(p=>[p.id,p.name])])):h('small',null,'人设包已停用，当前使用基础助手。'),
        field('聊天背景',area(draft.environment,v=>set('environment',v),{rows:4,maxLength:2000,placeholder:'例如：这是摄影交流群，大家常讨论相机；不用每句话都接。'}),'描述主题、称呼和聊天习惯，不会授予工具权限。')),
      h('section',null,heading('接话节奏','tune'),check('判断是否值得接话',draft.decisionEnabled,v=>set('decisionEnabled',v),{help:'用于自然参与和同群接话。全局开启无 @ 意图识别时，续聊仍会辨认交流对象；@ 和引用她可直接唤醒。判断阶段不执行工具。'}),
        h('div',{className:'qqb-grid'},numberField('连续消息等待',draft.mergeWindowMs,v=>set('mergeWindowMs',v),0,5000,'毫秒；同一人的补充合并处理，0 为关闭'),numberField('最长等待',draft.maxCollectMs,v=>set('maxCollectMs',v),1000,10000,'毫秒；避免一直等不到回应')),
        numberField('旧回复有效期',draft.staleAfterSec,v=>set('staleAfterSec',v),15,180,'秒；群内已有后续消息时，过时的纯聊天回复不再发送')),
      h('section',null,heading('这里可以使用的工具','tune',kind==='group'?'下方预览主人在此群的有效权限，普通成员仍按各自授权执行。':'下方预览这位好友的有效权限。'),
        h('div',{className:'qqb-tool-summary'},details.tools.filter(t=>!t.reason).map(t=>h('span',{className:'qqb-pill',key:t.id},t.name))),
        !details.tools.some(t=>!t.reason)?h('p',null,'当前没有可执行的工具。'):null,
        h('small',null,'适用于普通成员的授权：'+(rules.length?rules.map(g=>(data.capabilities.find(c=>c.id===g.capability)?.description||g.capability)+'（'+(g.allUsers?'所有聊天成员':g.users.join('、'))+'）').join('；'):'尚未设置。')),
        button('调整主人与授权',()=>navigate('permissions'),{className:'qqb-quiet'})),
      h(Activity,{data,chatKey:key}),h('div',{className:'qqb-savebar'},h('small',{className:errors.length?'qqb-field-error':undefined},errors[0]||'保存后用于下一轮；不会改变已启用动作或原有授权。'),button('保存这个聊天',save,{disabled:busy||!!errors.length||!data.status?.bot,className:'qqb-primary'}))):h('p',{className:'qqb-empty'},'选择一个群或好友，开始设置。'),
      h('details',{className:'qqb-advanced'},h('summary',null,'全局聊天默认设置'),h(Conversations,{data,act,busy,notify})),h('details',{className:'qqb-advanced'},h('summary',null,'全局接收范围'),h(Listening,{data,act,busy,notify})));
  }

  function QQDebug({data,busy,notify}){
    const [kind,setKind]=useState('private'),[peer,setPeer]=useState(data.framework.ownerQQ),[capability,setCapability]=useState('core.status'),[args,setArgs]=useState('{}'),[working,setWorking]=useState(false),[purpose,setPurpose]=useState('image');
    const key=(data.status?.bot||'')+':'+kind+':'+peer;
    const invoke=async()=>{setWorking(true);try{const result=await api('invokeAction',{revision:data.revision,key,capability,arguments:JSON.parse(args)});notify(JSON.stringify(result));}catch(e){notify(e.message,true);}finally{setWorking(false);}};
    return h('details',{className:'qqb-advanced'},h('summary',null,icon('tune'),h('span',null,'手动测试 QQ 动作')),
      h('div',{className:'qqb-advanced-body'},h('small',null,'开发调试用。直接执行一次已授权的 QQ 动作，或上传供测试使用的媒体；日常聊天不需要在这里操作。'),
        h('div',{className:'qqb-grid'},field('测试聊天类型',select(kind,v=>{setKind(v);setPeer(v==='private'?data.framework.ownerQQ:data.framework.listenGroups[0]||'');},[['private','私聊'],['group','群聊']])),
          (kind==='group'?picker(data,notify,'测试群','groups',peer,setPeer,{allowedIds:data.framework.listenGroups}):field('测试 QQ',input(peer,setPeer,{readOnly:true})))),
        field('资源用途',select(purpose,setPurpose,[['image','图片'],['audio','语音'],['video','视频'],['file','文件']])),
        field('上传测试资源',h('input',{type:'file','aria-label':'上传 QQ 资源',disabled:working,onChange:async e=>{
          const file=e.target.files?.[0];if(!file)return;if(file.size>8*1024*1024){notify('资源最大 8 MB',true);return;}
          setWorking(true);try{const reader=new FileReader(),base64=await new Promise((resolve,reject)=>{reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
            const resource=await api('uploadMedia',{revision:data.revision,key,purpose,name:file.name,base64});setArgs(JSON.stringify({resourceId:resource.id},null,2));notify('测试资源已上传，有效期一小时。');
          }catch(error){notify(error.message,true);}finally{setWorking(false);}
        }})),
        field('测试动作',select(capability,v=>{setCapability(v);setArgs('{}');},data.capabilities.filter(c=>data.framework.enabledActions.includes(c.id)).map(c=>[c.id,c.description]))),
        field('参数 JSON',area(args,setArgs,{rows:5,spellCheck:false})),button(working?'执行中…':'执行一次',invoke,{disabled:working||busy||!peer||!data.framework.enabledActions.includes(capability)})));
  }
  function MediaSettings({data,act,busy,notify}){
    const [s,setS]=useState(()=>copy(data.settings)),[model,setModel]=useState(data.mediaStatus?.lastModel||null),[checking,setChecking]=useState(false);
    const set=(k,v)=>setS(old=>({...old,[k]:v}));
    return h('div',null,
      h('section',null,heading('媒体输入','chat','把 QQ 附件送进 DSH，并明确区分“收到文件”和“理解内容”。'),
        button(checking?'检查中…':'检查当前模型',async()=>{setChecking(true);try{setModel(await api('mediaInfo'));}catch(e){notify(e.message,true);}finally{setChecking(false);}},{disabled:checking}),
        model&&h('div',{className:'qqb-hint'},model.model+' · '+(model.vision?'支持原生图片输入':'未声明图片输入，图片会尝试 OCR 文字识别')),
        check('接收图片',s.mediaImages!==false,v=>set('mediaImages',v),{help:'支持视觉的模型会收到真实图片；文本模型只尝试 OCR，不假装看懂画面。'}),
        check('接收语音',s.mediaAudio!==false,v=>set('mediaAudio',v),{help:'使用 NapCat 按原消息转写文字，原语音尽可能作为文件附加。转写可能受 QQ 服务限制。'}),
        check('接收文件',s.mediaFiles!==false,v=>set('mediaFiles',v),{help:'原文件保存为 DSH 附件；提取 TXT、Markdown、CSV、JSON、DOCX 和 PDF 正文，其他格式明确提示。'}),
        check('接收视频',s.mediaVideo!==false,v=>set('mediaVideo',v),{help:'保存原视频，最多抽取前 15 秒的 3 帧画面；当前不转写视频音轨。需要本机已安装 ffmpeg。'}),
        h('small',null,'单个附件最多 8 MB，每条最多 4 个、总计 16 MB；文件正文最多 20000 字，PDF 最多前 10 页。群里可先发附件，再 @机器人问“看一下刚才的附件”，仅关联同一发送者两分钟内的附件。')),
      h('section',null,heading('最近处理结果','tune'),(data.mediaStatus?.recent||[]).length?data.mediaStatus.recent.map((r,i)=>h('div',{key:i,className:'qqb-reason'},h('small',null,new Date(r.at).toLocaleString()),r.items.map((item,j)=>h('p',{key:j},item.name+' · '+(item.delivered?(item.attached?'已送入 DSH':'已送入处理说明'):'尚未送入 DSH')+' · '+(item.interpreted?'已提供图片或提取内容':'未提取内容')+(item.error?' · '+item.error:''))))):h('p',{className:'qqb-empty'},'暂无媒体处理记录。')),
      h('div',{className:'qqb-savebar'},h('small',null,'媒体处理不会向 QQ 开放电脑或服务器操作。'),button('保存媒体设置',()=>act('saveMediaSettings',{settings:{mediaImages:s.mediaImages!==false,mediaAudio:s.mediaAudio!==false,mediaFiles:s.mediaFiles!==false,mediaVideo:s.mediaVideo!==false}}),{disabled:busy,className:'qqb-primary'})));
  }
  function Status({data,onSettings,busy,notify}) {
    const d=data.diagnostics||{received:0,accepted:0,ignored:0,recentIgnored:[]};
    const states={skipped:'略过重复回复',done:'已回复',accepted:'网关已受理',queued:'等待处理',running:'正在回复','reply-ready':'准备发送',sending:'正在发送',failed:'处理失败',uncertain:'发送结果待确认',cancelled:'已取消'};
    const groupHint=!data.settings.groupEnabled?'群聊未开启':!data.settings.allowedGroups.length?'群白名单为空，@机器人也不会回复。':null;
    const chatName=key=>{const parts=key.split(':');return(parts[1]==='group'?'群 ':'QQ ')+parts[2];};
    return h('div',null,
      h('section',null,h('div',{className:'qqb-account'},h('div',{className:'qqb-account-icon'},icon('chat')),h('div',null,
        h('strong',null,data.status?.nickname||'QQ 连接'),h('small',null,data.status?.bot|| (data.status?.state==='listening'?'等待 NapCat 连接':'等待连接')))),
        h('div',{className:'qqb-status-grid'},[['收到',d.received],['已接收',d.accepted],['已忽略',d.ignored]].map(([label,value])=>h('div',{key:label,className:'qqb-stat'},h('strong',null,value||0),h('small',null,label)))),
        groupHint&&h('div',{className:'qqb-hint qqb-warning'},groupHint,' ',button('去设置',onSettings,{className:'qqb-quiet'})),
        !data.status?.online&&data.status?.error&&h('p',{className:'qqb-error'},'暂时连接不上 QQ，请检查 NapCat 和连接设置。'),
        h('details',{className:'qqb-subtle-details'},h('summary',null,'连接详情'),h('p',null,'状态：'+(data.status?.state||'未知')),data.status?.error&&h('p',null,data.status.error),
          h('small',null,'数据目录：'+data.dataDir),h('small',null,'媒体、资料及消息动作在“主人与权限”中单独授权。'))),
      h('section',null,heading('最近消息','chat'),data.jobs.length?data.jobs.slice().reverse().map(job=>h('details',{key:job.id,className:'qqb-job'},
        h('summary',null,(states[job.status]||job.status)+' · '+chatName(job.message.key)),h('p',null,job.message.text),h('small',null,'DSH 会话：'+(job.sessionId||'尚未创建')),
        job.error&&h('p',{className:'qqb-error'},job.error))):h('p',{className:'qqb-empty'},'还没有收到可回复的消息。')),
      d.recentIgnored?.length?h('section',null,heading('为什么没有回复','users'),d.recentIgnored.map((row,i)=>h('div',{key:i,className:'qqb-reason'},
        h('div',null,row.message),h('small',null,(row.kind==='group'?'群 ':'QQ ')+row.peer+' · 发送者 '+row.user+' · '+new Date(row.time).toLocaleTimeString())))):null,
      h('details',{className:'qqb-advanced'},h('summary',null,icon('tune'),h('span',null,'运行日志')),h('div',{className:'qqb-advanced-body'},
        h('div',{className:'qqb-log'},data.logs.slice(-35).reverse().map((line,i)=>h('p',{key:i},h('time',null,new Date(line.time).toLocaleTimeString()),line.message))))),
      h(QQDebug,{data,busy,notify}),h('small',null,'工具执行由核心权限控制。高危操作始终不开放。'));
  }
  function Listening({data,act,busy,notify}){
    const [f,setF]=useState(()=>copy(data.framework)),[groups,setGroups]=useState(null);
    const set=(key,value)=>setF(old=>({...old,[key]:value}));
    const errors=[idError(f.listenUsers),idError(f.listenGroups)].filter(Boolean);
    return h('div',null,
      h('section',null,heading('监听范围','users','监听只接收事件；是否回复、能否执行动作分别设置。'),
        check('监听私聊消息',f.listenPrivate,v=>set('listenPrivate',v)),
        field('私聊监听对象',select(f.listenAllPrivate?'all':'selected',v=>set('listenAllPrivate',v==='all'),[['all','所有私聊用户'],['selected','指定 QQ']])),
        !f.listenAllPrivate&&picker(data,notify,'监听的用户 QQ','friends',f.listenUsers,v=>set('listenUsers',v),{multiple:true}),
        picker(data,notify,'监听的群','groups',f.listenGroups,v=>set('listenGroups',v),{multiple:true}),
        check('监听成员变动与其他通知',f.listenNotices,v=>set('listenNotices',v)),
        check('接收好友与加群请求',f.listenRequests,v=>set('listenRequests',v),{help:'请求进入收件箱，由主人手动处理。'}),
        button('保存监听范围',()=>act('saveFramework',{framework:f}),{disabled:busy||errors.length>0,className:'qqb-primary'})),
      h('section',null,heading('最近事件','chat'),h('small',null,'本次启动已接收 '+(data.eventState?.count||0)+' 个事件；这里只展示事件信息。'),
        (data.eventState?.recent||[]).slice(0,15).map((e,i)=>h('div',{key:i,className:'qqb-reason'},h('span',null,({message:'消息',notice:'通知',request:'请求',meta:'连接事件'}[e.type]||e.type)+' · '+e.name),h('small',null,(e.peer||'')+' · '+new Date(e.time).toLocaleTimeString())))),
      h('section',null,heading('请求收件箱','users'),
        h('small',null,'处理请求需先在“主人与权限”启用对应动作，不会自动加入白名单。'),
        (data.eventState?.requests||[]).length?(data.eventState.requests.map(r=>h('div',{key:r.requestId,className:'qqb-reason'},
          h('div',null,(r.name==='friend'?'好友请求':'加群请求')+' · '+r.user),h('small',null,r.comment||r.peer),h('small',null,({pending:'待处理',handled:'已处理',accepted:'网关已受理',unknown:'结果未知',submitting:'正在处理'}[r.state]||r.state)),
          r.state==='pending'&&h('div',{className:'qqb-row'},[true,false].map(approve=>button(approve?'同意':'拒绝',async()=>{
            try{const result=await api('invokeAction',{revision:data.revision,key:data.status.bot+':private:'+data.framework.ownerQQ,capability:'qq.request.decide',arguments:{requestId:r.requestId,approve,reason:''}});notify(result.outcome==='confirmed'?'请求已处理':'网关已受理，请等待确认');}catch(e){notify(e.message,true);}
          },{key:String(approve),disabled:busy||!data.framework.enabledActions.includes('qq.request.decide')})))))):h('p',{className:'qqb-empty'},'没有待处理的请求。')) );
  }
  function PermissionsPage({data,act,busy,notify}){
    const [f,setF]=useState(()=>copy(data.framework)),[grant,setGrant]=useState({capability:'',users:'',groups:'',private:true,allUsers:false,deny:false,expires:'',perMinute:'5'});
    const enabled=f.enabledActions,set=(k,v)=>setF(old=>({...old,[k]:v})),grantable=data.capabilities.filter(c=>enabled.includes(c.id)&&!c.ownerOnly&&(!grant.allUsers||c.publicSafe));
    function addGrant(){
      if(!grant.capability||idError(grant.users)||!grant.allUsers&&!ids(grant.users).length||idError(grant.groups)||numberError(grant.perMinute,1,30,'每分钟额度')){notify('请选择工具，并填写有效的用户、范围与额度。',true);return;}
      if(!grant.private&&!ids(grant.groups).length){notify('请选择私聊或指定群。',true);return;}
      if(grant.expires&&!Number.isFinite(Date.parse(grant.expires))){notify('到期时间无效。',true);return;}
      set('grants',[...f.grants,{...grant,id:crypto.randomUUID(),users:ids(grant.users),groups:ids(grant.groups),expires:grant.expires?new Date(grant.expires).toISOString():'',perMinute:Number(grant.perMinute)}]);
      setGrant({...grant,users:'',groups:''});
    }
    const publicId=id=>'shared-'+id.replaceAll('.','-'),shared=id=>f.grants.some(g=>g.id===publicId(id)&&g.allUsers&&!g.deny);
    const share=(id,on)=>setF(old=>({...old,grants:on?[...old.grants.filter(g=>g.id!==publicId(id)),{id:publicId(id),capability:id,allUsers:true,users:[],groups:data.settings.groupEnabled?data.settings.allowedGroups.filter(g=>old.listenGroups.includes(g)):[],private:!!data.settings.privateEnabled,deny:false,expires:'',perMinute:5}]:old.grants.filter(g=>g.id!==publicId(id))}));
    return h('div',null,
      h('section',null,heading('主人','person','按真实 QQ 号识别主人，昵称和群管理员身份不会授予管理权。'),
        field('主要主人 QQ',input(f.ownerQQ,v=>setF(old=>({...old,ownerQQ:v,ownerQQs:[v,...ownerIds(old).filter(id=>id!==old.ownerQQ)]})),{inputMode:'numeric',maxLength:16}),undefined,idError(f.ownerQQ)||(!f.ownerQQ?'请填写主人 QQ':'')),
        picker(data,notify,'其他主人 QQ','friends',ownerIds(f).filter(id=>id!==f.ownerQQ),v=>set('ownerQQs',[f.ownerQQ,...ids(v)]),{multiple:true}),
        h('small',null,'可从好友列表添加，也可输入 QQ 号。其他主人拥有相同的机器人管理及已授权工具权限；高危操作仍禁止。此列表只在本机设置页修改。主人身份不影响群聊是否接话。'),
        check('暂停回复与工具任务',f.paused,v=>set('paused',v),{help:'主人仍可直接说“恢复机器人”，也可回到这里关闭暂停。'}),
        h('div',{className:'qqb-hint'},'主人可以在私聊和允许的群里使用已开启的工具。在群里说“修改这个群的名称”会作用于当前群，无需记群号。')),
      h('section',null,heading('主人可用的工具','tune','开启后直接用自然语言提问或提出要求，无需任何前缀。'),
        data.capabilities.map(c=>check(c.description,enabled.includes(c.id),on=>setF(old=>({...old,enabledActions:on?[...new Set([...old.enabledActions,c.id])]:old.enabledActions.filter(id=>id!==c.id),grants:on?old.grants:old.grants.filter(g=>g.capability!==c.id)})),
          {help:(c.ownerOnly?'仅主人':c.publicSafe?'安全查询，可选择开放给其他人':'按范围单独授权')+(c.extension?' · 需要网关支持':'')}))),
      h('section',null,heading('其他人的查询工具','users','只显示已启用、支持安全共享的查询。范围是当前允许聊天的私聊和群，每人每项每分钟 5 次。'),
        data.capabilities.filter(c=>enabled.includes(c.id)&&c.publicSafe&&!c.ownerOnly).map(c=>check('开放：'+c.description,shared(c.id),v=>share(c.id,v))),
        h('small',null,'天气等插件可声明安全查询能力，启用后也会出现在这里。共享前在插件设置选择适用用户和生效群。修改资料、发送文件等不会因这里的开关被共享。')),
      h('details',{className:'qqb-advanced'},h('summary',null,icon('users'),h('span',null,'指定用户与特殊范围')),
        h('div',{className:'qqb-advanced-body'},
          f.grants.length?f.grants.map(g=>h('div',{key:g.id,className:'qqb-reason'},h('div',null,(g.deny?'拒绝':'允许')+' · '+(data.capabilities.find(c=>c.id===g.capability)?.description||g.capability)),
            h('small',null,(g.allUsers?'所有聊天用户':'用户 '+g.users.join('、'))+' · '+(g.private?'私聊 ':'')+(g.groups.length?'群 '+g.groups.join('、'):'')+' · 每分钟 '+g.perMinute+' 次'),
            g.expires&&h('small',null,'到期 '+new Date(g.expires).toLocaleString()),button('撤销',()=>set('grants',f.grants.filter(x=>x.id!==g.id))))):h('p',{className:'qqb-empty'},'暂无范围授权。'),
          h('h4',null,'添加规则'),check('面向所有聊天用户',grant.allUsers,v=>setGrant(g=>({...g,allUsers:v,capability:''})),{help:'此方式只允许选择安全查询。'}),
          field('具体能力',select(grant.capability,v=>setGrant(g=>({...g,capability:v})),[['','选择已启用的工具'],...grantable.map(c=>[c.id,c.description])])),
          !grant.allUsers&&picker(data,notify,'用户 QQ','friends',grant.users,v=>setGrant(g=>({...g,users:v})),{multiple:true}),
          check('允许在私聊中使用',grant.private,v=>setGrant(g=>({...g,private:v}))),
          picker(data,notify,'允许的群','groups',grant.groups,v=>setGrant(g=>({...g,groups:v})),{multiple:true,allowedIds:f.listenGroups}),
          h('div',{className:'qqb-grid'},numberField('每分钟额度',grant.perMinute,v=>setGrant(g=>({...g,perMinute:v})),1,30),field('到期时间',input(grant.expires,v=>setGrant(g=>({...g,expires:v})),{type:'datetime-local'}))),
          check('此规则为明确拒绝',grant.deny,v=>setGrant(g=>({...g,deny:v}))),button('加入规则',addGrant))),
      h('details',{className:'qqb-advanced'},h('summary',null,icon('tune'),h('span',null,'始终禁止的操作')),
        h('div',{className:'qqb-advanced-body'},data.systemDenied.map(text=>h('p',{key:text},text)))),
      h('section',null,heading('执行记录','tune'),data.framework.audit.slice(-15).reverse().map((r,i)=>h('div',{key:i,className:'qqb-reason'},h('div',null,(data.capabilities.find(c=>c.id===r.capability)?.description||r.capability)+' · '+({denied:'已拒绝',started:'开始',completed:'完成',failed:'失败',unknown:'结果未知'}[r.outcome]||r.outcome)),h('small',null,r.actor+' · '+(r.kind==='group'?'群 ':'私聊 ')+r.peer+' · '+r.reason)))),
      h('div',{className:'qqb-savebar'},h('small',null,'保存后立即撤销旧任务的授权。'),button('保存权限',()=>act('saveFramework',{framework:f}),{disabled:busy||!f.ownerQQ||!!idError(f.ownerQQ)||!!idError(f.ownerQQs||[])||ownerIds(f).length>20,className:'qqb-primary'})));
  }
  function PokeFields({config,setConfig,data,notify}){
    const set=(key,value)=>setConfig(c=>({...c,[key]:value}));
    return h('div',null,
      field('互动方式',select(config.mode||'text',v=>set('mode',v),[['text','只用文字回应'],['poke','只回戳'],['both','回戳并回应'],['auto','让 AI 判断']])),
      check('允许自动回戳',config.autoPokeEnabled,v=>set('autoPokeEnabled',v),{help:'仅回戳这次戳机器人的人；每人每分钟最多一次，受当前聊天范围和核心动作开关限制。'}),
      config.autoPokeEnabled&&!data.framework.enabledActions.includes('qq.poke')&&h('p',{className:'qqb-field-error'},'请在主人与授权中启用“戳一戳当前消息发起者”。'),
      field('文字来源',select(config.textSource||'ai',v=>set('textSource',v),[['ai','使用 AI 和当前人设'],['fixed','使用固定文字']])),
      field('固定文字 / AI 停用时的回应',area(config.text,v=>set('text',v),{maxLength:80,rows:2})),
      h('div',{className:'qqb-grid'},numberField('互动冷却',config.cooldown??30,v=>set('cooldown',v),5,600,'秒；同人冷却，聊天另有 10 秒间隔'),numberField('回应概率',config.probability??100,v=>set('probability',v),0,100,'%')),
      numberField('回戳概率',config.pokeProbability??100,v=>set('pokeProbability',v),0,100,'%'),
      check('回应后允许继续交谈',config.continueConversation!==false,v=>set('continueConversation',v)),
      check('允许群聊互动',config.group!==false,v=>set('group',v)),check('允许私聊互动',config.private!==false,v=>set('private',v)),
      picker(data,notify,'互动的群','groups',config.groups||[],v=>set('groups',v),{multiple:true,allowedIds:data.framework.listenGroups}),h('small',null,'留空沿用聊天对象范围；指定后只在这些群响应。'),
      picker(data,notify,'互动的用户','friends',config.users||[],v=>set('users',v),{multiple:true}),h('small',null,'留空沿用聊天成员范围。AI 停用时使用固定文字；只回戳无需 AI。'));
  }

  function BuiltinCard({item,act,busy,data,notify}){
    const [config,setConfig]=useState(()=>copy(item.config||{})),[enabled,setEnabled]=useState(item.enabled),uninstall=React.useContext(UninstallContext);
    const normalized=item.id==='welcome'?{...config,groups:ids(config.groups)}:item.id==='poke'?{...config,groups:ids(config.groups),users:ids(config.users),cooldown:Number(config.cooldown),probability:Number(config.probability),pokeProbability:Number(config.pokeProbability)}:config;
    const pokeErrors=item.id==='poke'?[numberError(config.cooldown,5,600,'互动冷却'),numberError(config.probability,0,100,'回应概率'),numberError(config.pokeProbability,0,100,'回戳概率'),idError(config.groups),idError(config.users),['poke','both'].includes(config.mode)&&!config.autoPokeEnabled?'请明确开启自动回戳许可':''].filter(Boolean):[];
    return h('section',null,h('div',{className:'qqb-row'},h('h3',null,item.name),h('span',{className:'qqb-pill'},item.uninstalled?'未安装':'内置包')),
      h('p',null,item.description),h('small',null,item.id),
      !item.uninstalled&&check('启用 '+item.name,enabled,async value=>{setEnabled(value);const result=await act('configureBuiltin',{id:item.id,enabled:value,config:normalized});if(!result)setEnabled(item.enabled);},{disabled:busy}),
      item.id==='welcome'&&!item.uninstalled&&h('details',{className:'qqb-subtle-details'},h('summary',null,'欢迎设置'),
        picker(data,notify,'欢迎的群','groups',config.groups,v=>setConfig(c=>({...c,groups:v})),{multiple:true,allowedIds:data.framework.listenGroups}),
        field('欢迎内容',area(config.text,v=>setConfig(c=>({...c,text:v})),{rows:3})),
        button('保存欢迎设置',()=>act('configureBuiltin',{id:item.id,enabled:item.enabled,config:normalized}),{disabled:busy})),
      item.id==='poke'&&!item.uninstalled&&h('details',{className:'qqb-advanced'},h('summary',null,'互动设置'),h('div',{className:'qqb-advanced-body'},h(PokeFields,{config,setConfig,data,notify}),pokeErrors[0]&&h('p',{className:'qqb-field-error'},pokeErrors[0]),button('保存互动设置',()=>act('configureBuiltin',{id:item.id,enabled:item.enabled,config:normalized}),{disabled:busy||!!pokeErrors.length,className:'qqb-primary'}))),
      button(item.uninstalled?'重新安装':'卸载包',()=>item.uninstalled?act('restorePackage',{kind:'builtin',id:item.id}):uninstall({kind:'builtin',id:item.id,name:item.name}),{disabled:busy,className:'qqb-quiet'}));
  }
  function App() {
    const [data,setData]=useState(null),[tab,setTab]=useState('overview'),[message,setMessage]=useState(null),[busy,setBusy]=useState(false),[loadError,setLoadError]=useState(''),[query,setQuery]=useState(''),[dirty,setDirty]=useState(false),[pendingTab,setPendingTab]=useState(null),[expanded,setExpanded]=useState(true),[uninstallTarget,setUninstallTarget]=useState(null);
    const notify=(text,error=false)=>setMessage({text,error});
    async function refresh(){try{setData(await api('snapshot'));setLoadError('');}catch(e){setLoadError(e.message);}}
    useEffect(()=>{void refresh();const timer=setInterval(()=>api('snapshot').then(setData).catch(()=>{}),4000);return()=>clearInterval(timer);},[]);
    useEffect(()=>{const guard=e=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty]);
    async function act(action,args) {if(busy)return;setBusy(true);setMessage(null);try{const result=await api(action,{revision:data.revision,...args});setData(result);setDirty(false);notify('已保存');return result;}catch(e){await refresh();notify(e.message,true);return null;}finally{setBusy(false);}}
    const navigate=id=>{if(id===tab)return;if(dirty){setPendingTab(id);return;}setTab(id);setMessage(null);};
    if(!data)return h('div',{className:'qqb'},h('h2',null,'QQ 框架'),h('p',null,loadError||'正在加载…'),loadError&&button('重试',refresh));
    const tabs=[['overview','总览','chat','在线 状态 当前人设'],['rooms','聊天对象','users','群 好友 监听 接话 等待 概率'],...(data.framework.builtins.persona.enabled?[['personas','人设','person','角色 提示词 默认 绑定']]:[]),['plugins','插件','tune','市场 安装 扩展'],['permissions','主人与授权','person','权限 动作 主人 共享'],['settings','连接与媒体','link','OneBot 端口 Token 模型 图片 语音 视频 文件'],['activity','活动记录','chat','日志 未回复 任务 错误']];
    const found=query.trim()?tabs.filter(t=>(t[1]+' '+t[3]).toLowerCase().includes(query.toLowerCase())):[];
    let panel=tab==='overview'?h(Overview,{data,navigate}):tab==='rooms'?h(ChatObjects,{data,act,busy,notify,navigate,dirty,onClean:()=>setDirty(false)}):tab==='personas'?h(Personas,{data,act,busy,notify}):tab==='plugins'?h(Plugins,{data,act,busy,notify}):tab==='permissions'?h(PermissionsPage,{data,act,busy,notify}):tab==='activity'?h('div',null,h(Activity,{data}),h(Status,{data,onSettings:()=>navigate('rooms'),busy,notify})):h('div',null,h(Settings,{data,act,busy,notify}),h('details',{className:'qqb-advanced'},h('summary',null,'图片、语音、文件和视频'),h(MediaSettings,{data,act,busy,notify})));
    return h(UninstallContext.Provider,{value:setUninstallTarget},h('div',{className:'qqb qqb-workspace'+(expanded?' is-expanded':'')},h('div',{className:'qqb-header'},h('div',{className:'qqb-brand'},icon('chat'),h('h2',null,'QQ 框架')),button(expanded?'收起面板':'展开面板',()=>setExpanded(v=>!v),{className:'qqb-quiet'}),h('a',{className:'qqb-admin-link',href:'http://127.0.0.1:3097/',target:'_blank',rel:'noopener'},icon('link'),'独立管理站点'),h('span',{className:'qqb-status'+(data.status?.online?' is-online':'')},data.status?.online?'QQ 在线':'未连接')),
      h('div',{className:'qqb-search'},input(query,setQuery,{placeholder:'查找设置…','aria-label':'查找设置'}),found.length?h('div',{className:'qqb-search-results'},found.map(t=>button(t[1],()=>{navigate(t[0]);setQuery('');},{key:t[0]}))):query?h('small',null,'没有匹配的设置'):null),
      message&&h('div',{role:message.error?'alert':'status',className:message.error?'qqb-notice qqb-error':'qqb-notice'},h('span',null,message.text),button('×',()=>setMessage(null),{'aria-label':'关闭提示'})),
      pendingTab&&h('div',{className:'qqb-notice',role:'status'},h('span',null,'这页还有未保存的修改。'),button('继续编辑',()=>setPendingTab(null)),button('放弃修改并切换',()=>{setDirty(false);setTab(pendingTab);setPendingTab(null);})),
      h('div',{className:'qqb-layout'},h('nav',{className:'qqb-sidebar',role:'tablist','aria-label':'QQ 框架导航','aria-orientation':'vertical'},tabs.map(([id,label,name],i)=>button(h(React.Fragment,null,icon(name),label),()=>navigate(id),{key:id,id:'qqb-tab-'+id,role:'tab','aria-selected':tab===id,'aria-controls':'qqb-panel',tabIndex:tab===id?0:-1,onKeyDown:e=>{if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const n=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowDown'?1:tabs.length-1))%tabs.length;navigate(tabs[n][0]);document.getElementById('qqb-tab-'+tabs[n][0])?.focus();}}}))),
      h('div',{id:'qqb-panel',className:'qqb-content',role:'tabpanel','aria-labelledby':'qqb-tab-'+tab,onChangeCapture:e=>{if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)&&!e.target.closest('[data-browse]')&&e.target.type!=='search')setDirty(true);}},h('div',{className:'qqb-page-title'},h('h3',null,tabs.find(t=>t[0]===tab)?.[1]||'设置'),dirty&&h('small',null,'有未保存的修改')),panel))),uninstallTarget&&h(UninstallWizard,{target:uninstallTarget,data,act,onClose:()=>setUninstallTarget(null)}));
  }
  const css="\n.qqb{--qb-accent:#4f63e6;--qb-accent-2:#2bb8a3;--qb-accent-soft:color-mix(in srgb,var(--qb-accent) 9%,transparent);--qb-line:color-mix(in srgb,currentColor 11%,transparent);--qb-soft:color-mix(in srgb,currentColor 3%,transparent);--qb-muted:color-mix(in srgb,currentColor 58%,transparent);--qb-base:Canvas;max-width:840px;padding:24px 28px 32px;box-sizing:border-box;color:inherit;font:inherit;font-size:13px;line-height:1.6;container-type:inline-size}\n.qqb *{box-sizing:border-box}.qqb h2{font-size:21px;font-weight:650;letter-spacing:-.5px;margin:0}.qqb h3{font-size:14px;font-weight:620;margin:0;line-height:1.6}.qqb h4{font-size:13px;font-weight:600;margin:8px 0}.qqb p{margin:7px 0}.qqb small{display:block;font-size:12px;line-height:1.55;color:var(--qb-muted);overflow-wrap:anywhere}.qqb section{border:1px solid var(--qb-line);border-radius:13px;padding:18px;margin:14px 0;background:transparent;box-shadow:0 2px 8px #00000002}.qqb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.qqb-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.qqb-brand{display:flex;align-items:center;gap:11px}.qqb-brand-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;color:var(--qb-accent);background:var(--qb-accent-soft)}.qqb-brand-icon svg{width:20px;height:20px}.qqb-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;color:var(--qb-muted);font-size:12px}.qqb-status:before{content:\"\";width:6px;height:6px;border-radius:50%;background:#9ca3af}.qqb-status.is-online:before{background:#31a06c;box-shadow:0 0 0 3px #31a06c13}.qqb-status.is-online{color:#2b8a60}\n.qqb-tabs{display:flex;gap:3px;overflow-x:auto;padding:4px;border:1px solid color-mix(in srgb,currentColor 3%,transparent);background:var(--qb-soft);border-radius:10px;margin:10px 0 20px}.qqb .qqb-tabs button{flex:1;border:1px solid transparent;box-shadow:none;border-radius:7px;min-height:33px;padding:6px 8px;font-size:12px;color:var(--qb-muted);white-space:nowrap}.qqb .qqb-tabs button[aria-selected=true],.qqb .qqb-tabs button[aria-pressed=true]{background:var(--qb-base);color:inherit;border-color:var(--qb-line);box-shadow:0 1px 3px #00000006}\n.qqb button{display:inline-flex;align-items:center;justify-content:center;gap:5px;border:1px solid var(--qb-line);border-radius:8px;padding:7px 12px;min-height:34px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;font-weight:500;transition:background .15s,border-color .15s,box-shadow .15s;white-space:nowrap}.qqb button:hover{background:var(--qb-soft);border-color:color-mix(in srgb,currentColor 22%,transparent)}.qqb button:focus-visible,.qqb summary:focus-visible{outline:3px solid color-mix(in srgb,var(--qb-accent) 25%,transparent);outline-offset:2px}.qqb button:disabled{opacity:.42;cursor:default}.qqb .qqb-primary{background:var(--qb-accent);border-color:var(--qb-accent);color:#fff;box-shadow:0 2px 4px #4d66db16}.qqb .qqb-primary:hover:not(:disabled){background:#4058c9}.qqb .qqb-quiet{border-color:transparent;color:var(--qb-muted)}.qqb .qqb-enable{padding:5px 16px;background:var(--qb-soft);border-color:transparent;margin-top:0}.qqb-section-head{display:flex;align-items:flex-start;gap:9px;margin-bottom:15px}.qqb-section-head>svg{margin-top:2px;color:var(--qb-muted);flex:none;width:17px;height:17px}.qqb-section-head p{font-size:12px;margin:3px 0 0;color:var(--qb-muted)}\n.qqb-field{display:flex;flex-direction:column;gap:6px;margin:14px 0;flex:1;min-width:0}.qqb-field>label,.qqb-field>span{font-size:12px;font-weight:500}.qqb input:not([type=checkbox]):not([type=radio]):not([type=file]),.qqb textarea,.qqb select{min-width:0;width:100%;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:8px;padding:9px 11px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.5;outline:none;transition:border-color .15s,box-shadow .15s}.qqb input::placeholder,.qqb textarea::placeholder{color:color-mix(in srgb,currentColor 38%,transparent)}.qqb input:not([type=checkbox]):not([type=radio]):focus,.qqb textarea:focus,.qqb select:focus{border-color:var(--qb-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--qb-accent) 10%,transparent)}.qqb select{background-color:var(--qb-base);padding-right:25px}.qqb textarea{resize:vertical;min-height:64px}.qqb [aria-invalid=true]{border-color:#d76060!important}.qqb .qqb-field-error,.qqb .qqb-error{color:#c74d4d}.qqb-field[data-invalid] small{font-size:11px}.qqb .qqb-mono,.qqb input[inputmode=numeric]{font-variant-numeric:tabular-nums}.qqb-row>input,.qqb-row>select{flex:1;min-width:130px}.qqb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px}.qqb-grid .qqb-field{margin-top:10px;margin-bottom:4px}\n.qqb-check{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:9px 0;min-height:42px;cursor:pointer}.qqb-toggle-label{font-size:13px;font-weight:500}.qqb-check small{font-weight:400;margin-top:2px}.qqb-check input{appearance:none;-webkit-appearance:none;position:relative;width:32px;height:19px;min-width:32px;margin:0;border:1px solid color-mix(in srgb,currentColor 4%,transparent);border-radius:20px;background:color-mix(in srgb,currentColor 18%,transparent);cursor:pointer;transition:background .16s}.qqb-check input:after{content:\"\";position:absolute;width:13px;height:13px;top:2px;left:2px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #00000016;transition:transform .16s}.qqb-check input:checked{background:var(--qb-accent);border-color:transparent}.qqb-check input:checked:after{transform:translateX(13px)}.qqb-check input:focus-visible{outline:3px solid color-mix(in srgb,var(--qb-accent) 25%,transparent);outline-offset:2px}.qqb .is-disabled, .qqb fieldset:disabled{opacity:.45}.qqb .is-disabled input{cursor:default}\n.qqb-mode{border:0;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:9px}.qqb-mode legend{font-size:12px;font-weight:500;margin-bottom:7px}.qqb-mode label{display:flex;align-items:center;gap:9px;border:1px solid var(--qb-line);border-radius:9px;padding:10px 11px;cursor:pointer}.qqb-mode label.is-selected{border-color:color-mix(in srgb,var(--qb-accent) 48%,transparent);background:var(--qb-accent-soft)}.qqb-mode strong{font-size:12px;font-weight:600}.qqb-mode small{font-size:11px;margin-top:1px}.qqb-mode input{accent-color:var(--qb-accent);margin:0;width:13px;height:13px}.qqb-test-row{margin-top:14px}.qqb-separator{height:1px;background:var(--qb-line);margin:17px 0 12px}.qqb-hint{font-size:12px;line-height:1.65;color:var(--qb-muted);background:var(--qb-soft);padding:10px 12px;border-radius:8px;margin:8px 0}.qqb-warning{background:#b877070c;color:#946b1d;border:1px solid #b8770717}.qqb-group-options{border:0;border-left:2px solid var(--qb-line);padding:0 0 0 14px;margin:8px 0 4px}.qqb-group-list{max-height:220px;overflow:auto;margin-top:12px;border:1px solid var(--qb-line);border-radius:8px}.qqb-group-item{display:flex;align-items:center;gap:9px;padding:9px 11px;border-bottom:1px solid var(--qb-line);cursor:pointer}.qqb-group-item:last-child{border-bottom:0}.qqb-group-item input{accent-color:var(--qb-accent)}.qqb-group-item small{font-size:11px}\n.qqb-advanced{border:1px solid var(--qb-line);border-radius:11px;margin:14px 0}.qqb-advanced>summary{display:flex;align-items:center;gap:8px;padding:14px 16px;list-style:none;font-size:13px;font-weight:500;cursor:pointer}.qqb-advanced>summary:after{content:\"›\";margin-left:auto;color:var(--qb-muted);font-size:19px;font-weight:400;line-height:1;transition:transform .15s}.qqb-advanced[open]>summary:after{transform:rotate(90deg)}.qqb-advanced>summary::-webkit-details-marker{display:none}.qqb-advanced>summary>svg{color:var(--qb-muted);width:16px;height:16px}.qqb-advanced summary small{font-size:11px;font-weight:400}.qqb-advanced-body{padding:0 17px 17px;border-top:1px solid var(--qb-line)}.qqb-subtle-details{margin:12px 0 0;color:inherit;font-size:12px}.qqb-subtle-details>summary{cursor:pointer;color:var(--qb-muted);padding:5px 0}.qqb-subtle-details[open]>summary{margin-bottom:8px}.qqb-savebar{position:sticky;bottom:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--qb-base);padding:14px 0 2px;margin-top:18px;border-top:1px solid var(--qb-line)}.qqb-savebar:after{content:'';position:absolute;left:0;right:0;top:100%;height:40px;background:var(--qb-base);pointer-events:none}.qqb-savebar small{font-size:11px}.qqb-savebar button{min-width:92px}\n.qqb-persona-picker{margin-bottom:18px}.qqb-persona-picker select{flex:1;min-width:100px}.qqb .qqb-persona-picker button{padding:7px 9px}.qqb .qqb-prompt{min-height:250px;line-height:1.8;font-size:13px}.qqb-editor-meta{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--qb-muted);font-variant-numeric:tabular-nums;margin-top:-5px}.qqb-editor-actions{margin:18px 0 8px}.qqb-pill{display:inline-flex;align-items:center;gap:4px;border-radius:6px;padding:3px 7px;background:var(--qb-soft);color:var(--qb-muted);font-size:11px;white-space:nowrap}.qqb-pill svg{width:12px;height:12px}\n.qqb-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;margin:12px 0;border-radius:9px;border:1px solid #31a35e20;background:#31a35e09;font-size:12px;overflow-wrap:anywhere}.qqb-notice.qqb-error{border-color:#c74d4d25;background:#c74d4d08}.qqb-notice button{border:0;min-height:22px;padding:0 4px;color:var(--qb-muted)}.qqb-preview,.qqb-log{white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto;padding:13px;border-radius:8px;background:var(--qb-soft);font-size:11px;line-height:1.7}.qqb-log p{margin:5px 0}.qqb-log time{font-variant-numeric:tabular-nums;color:var(--qb-muted);margin-right:6px}.qqb-table{overflow:auto;margin-top:16px}.qqb table{width:100%;text-align:left;border-collapse:collapse}.qqb th,.qqb td{padding:9px 5px;border-bottom:1px solid var(--qb-line);font-size:11px;overflow-wrap:anywhere}.qqb th{color:var(--qb-muted);font-weight:500}.qqb td button{font-size:11px;padding:4px 7px;min-height:27px;margin:2px}.qqb-source{display:grid;grid-template-columns:1fr 110px;gap:8px;margin:12px 0}.qqb-source>input:nth-of-type(2){grid-column:1/-1}.qqb code{font-size:10px;overflow-wrap:anywhere}.qqb details:not(.qqb-advanced):not(.qqb-subtle-details){padding:6px 0}.qqb summary{cursor:pointer}.qqb-account{display:flex;align-items:center;gap:12px}.qqb-account-icon{display:grid;place-items:center;width:38px;height:38px;background:var(--qb-accent-soft);border-radius:12px;color:var(--qb-accent);flex:none}.qqb-account strong{display:block;font-size:14px;font-weight:600}.qqb-account small{font-variant-numeric:tabular-nums}.qqb-status-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0 0}.qqb-stat{padding:10px;border-radius:8px;background:var(--qb-soft)}.qqb-stat strong{display:block;font-size:20px;font-weight:550;font-variant-numeric:tabular-nums}.qqb-stat small{font-size:11px}.qqb-job{padding:9px 0;border-bottom:1px solid var(--qb-line)}.qqb-job:last-child{border-bottom:0}.qqb-job>summary{font-size:12px}.qqb-job small{margin-top:4px}.qqb-empty{padding:15px 0;text-align:center;color:var(--qb-muted);font-size:12px}.qqb-reason{font-size:12px;padding:10px 0;border-bottom:1px solid var(--qb-line)}.qqb-reason:last-child{border-bottom:0}.qqb-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}\n.dark .qqb,[data-theme=dark] .qqb{--qb-base:#1b1d21}.qqb fieldset:disabled .is-disabled{opacity:1}@container(max-width:390px){.qqb-mode{grid-template-columns:1fr}.qqb-advanced summary small{display:none}.qqb-persona-picker{gap:5px}.qqb .qqb-persona-picker button{padding:6px 7px}}@media(max-width:650px){.qqb{padding:18px 16px 28px}.qqb section{padding:15px}.qqb-source{grid-template-columns:1fr}.qqb-source>input:nth-of-type(2){grid-column:auto}.qqb h2{font-size:20px}}@media(prefers-reduced-motion:reduce){.qqb *{transition:none!important}}\n";
  const workspaceCss=`
.qqb-uninstall-overlay{position:fixed;inset:0;z-index:10000;max-width:none!important;background:#0006;display:grid;place-items:center;padding:24px!important}.qqb-uninstall-dialog{background:var(--qb-base);color:inherit;border:1px solid var(--qb-line);border-radius:16px;padding:24px;width:min(520px,100%);max-height:86vh;overflow:auto;box-shadow:0 16px 60px #0003}.qqb-uninstall-dialog h3{font-size:18px}.qqb-uninstall-dialog fieldset{border:0;padding:0;margin-top:16px}.qqb-uninstall-dialog legend{font-size:13px}.qqb-uninstall-choice{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--qb-line);border-radius:10px;margin:8px 0;cursor:pointer}.qqb-uninstall-choice input{margin-top:3px;accent-color:var(--qb-accent)}.qqb-uninstall-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.qqb .qqb-danger{background:#b54545;color:white;border-color:#b54545}
[role=dialog]:has(.qqb-workspace.is-expanded){width:min(1160px,calc(100vw - 40px));max-width:calc(100vw - 40px);height:min(92vh,980px)}.qqb.qqb-workspace{container-type:inline-size;max-width:1100px;padding:22px 24px 30px}.qqb-layout{display:grid;grid-template-columns:138px minmax(0,1fr);gap:24px;align-items:start}.qqb-sidebar{position:sticky;top:8px;display:flex;flex-direction:column;gap:5px;border:0;padding:0}.qqb-sidebar button{display:flex;gap:9px;align-items:center;justify-content:flex-start;border:0;background:transparent;padding:10px 12px;text-align:left;font-weight:500;color:var(--qb-muted);border-radius:9px}.qqb-sidebar button[aria-selected=true]{background:var(--qb-accent-soft);color:var(--qb-accent)}.qqb-content{min-width:0}.qqb-page-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.qqb-page-title h3{margin:0;font-size:19px}.qqb-page-title small{color:var(--qb-accent)}.qqb-search{margin:0 0 22px;position:relative}.qqb-search input{max-width:360px}.qqb-search-results{display:flex;gap:8px;flex-wrap:wrap;padding-top:8px}.qqb-overview-hero h3{font-size:23px;margin:5px 0}.qqb-overview-hero{background:linear-gradient(120deg,var(--qb-accent-soft),var(--qb-base));padding:24px!important}.qqb-overview-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.qqb-overview-stats section{padding:16px!important;display:flex;flex-direction:column;gap:9px;min-width:0}.qqb-overview-stats strong{font-size:19px;overflow-wrap:anywhere}.qqb-activity{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--qb-line)}.qqb-activity:last-child{border-bottom:0}.qqb-activity strong{font-weight:500}.qqb-activity small{display:block;margin-top:3px}.qqb-tool-summary{display:flex;flex-wrap:wrap;gap:6px}.qqb-content section{box-shadow:none}.qqb-content .qqb-savebar{bottom:0;background:var(--qb-base);z-index:2}.qqb-content .qqb-advanced{margin-top:16px}.qqb-content button:focus-visible,.qqb-sidebar button:focus-visible{outline:2px solid var(--qb-accent);outline-offset:2px}
@container(max-width:620px){.qqb-layout{grid-template-columns:1fr;gap:14px}.qqb-sidebar{position:static;flex-direction:row;flex-wrap:wrap;gap:4px}.qqb-sidebar button{padding:8px 10px}.qqb-sidebar svg{display:none}}
@media(max-width:700px){.qqb.qqb-workspace{padding:16px 12px}.qqb-layout{grid-template-columns:1fr;gap:15px}.qqb-sidebar{position:static;flex-direction:row;flex-wrap:wrap;gap:4px}.qqb-sidebar button{padding:8px 10px}.qqb-overview-stats{gap:8px}.qqb-overview-stats strong{font-size:16px}.qqb-search input{max-width:100%}}
.qqb .qqb-admin-link{display:inline-flex;align-items:center;gap:6px;padding:7px 11px;border:1px solid var(--qb-line);border-radius:9px;background:var(--qb-soft);color:var(--qb-muted);font-size:12px;text-decoration:none;transition:border-color .15s,color .15s,background .15s}
.qqb .qqb-admin-link:hover{border-color:var(--qb-line);color:var(--qb-accent);background:var(--qb-accent-soft);text-decoration:none}
.qqb .qqb-header .qqb-brand h2{letter-spacing:-.3px}
.qqb .qqb-sidebar button[aria-selected=true]{box-shadow:inset 2px 0 0 var(--qb-accent)}
.qqb .qqb-page-title h3{font-size:20px;letter-spacing:-.35px}
.qqb .qqb-content>section{border-radius:15px}
.qqb .qqb-content .qqb-overview-hero{background:linear-gradient(125deg,color-mix(in srgb,var(--qb-accent) 13%,var(--qb-base)),color-mix(in srgb,var(--qb-accent-2) 8%,var(--qb-base)))!important;border-color:color-mix(in srgb,var(--qb-accent) 22%,var(--qb-line))}
.qqb .qqb-primary{border:0;color:#fff;background:linear-gradient(135deg,var(--qb-accent),var(--qb-accent-2));box-shadow:0 6px 18px color-mix(in srgb,var(--qb-accent) 22%,transparent)}
.qqb .qqb-primary:hover{filter:brightness(1.05)}
`;
  return {inject:['slots'],apply(ctx){
    const style=document.createElement('style');style.textContent=css+workspaceCss;document.head.appendChild(style);
    ctx.effect(()=>()=>style.remove());
    ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'qq-bridge',order:60,label:'QQ 框架'},App));
  }};
 }
});
