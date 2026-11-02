const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8')
    .match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const good = 'time,on\n11/1/2026 12:00:00,1';
function setup(responses = [good]) {
    const timers = new Map(), events = {};
    let id = 0, requests = 0, destroyed = 0, charts = 0;
    const status = {textContent:'', classList:{add(){}, remove(){}}};
    const window = {addEventListener(name, cb) { events[name] = cb; }};
    const context = vm.createContext({
        window, URLSearchParams, console:{log(){},error(){}},
        document:{location:{search:''}, getElementById(name) {return name === 'status' ? status : {getContext(){return {};}};}},
        fetch: async () => {
            const result = responses[Math.min(requests++, responses.length - 1)];
            if (result instanceof Error) throw result;
            if (typeof result === 'function') return result();
            if (typeof result === 'object') return result;
            return {ok:true, text:async()=>result};
        },
        luxon:{DateTime:{fromFormat(value) { const date = new Date(value); return {isValid:Number.isFinite(+date),toJSDate:()=>date}; }}},
        Chart: function() { charts++; this.destroy = () => destroyed++; },
        setTimeout(fn, delay) {timers.set(++id,{fn,delay}); return id;},
        clearTimeout(id) {timers.delete(id);},
        setInterval(fn,delay) {timers.set(++id,{fn,delay,repeat:true}); return id;},
    });
    vm.runInContext(source, context);
    return {context, timers, events, status, window, get requests(){return requests;}, get destroyed(){return destroyed;}, get charts(){return charts;},
        async tick(){assert.equal(timers.size,1); const [key,{fn,repeat}]=[...timers][0];if (!repeat) timers.delete(key); await fn(); await flush();}};
}
const flush = () => new Promise(resolve=>setImmediate(resolve));
test('repeated success keeps exactly one timer and destroys each old chart', async()=>{
    const h=setup(); await flush();
    for(let i=0;i<8;i++) {assert.equal(h.timers.size,1);await h.tick();}
    assert.equal(h.requests,9);assert.equal(h.charts,9);assert.equal(h.destroyed,8);
    assert.match(h.status.textContent,/Online/);
});
test('initial rejection retries and recovers; backoff resets',async()=>{
    const h=setup([new Error('network'),new Error('network'),good]);await flush();
    assert.match(h.status.textContent,/unavailable/);assert.equal([...h.timers.values()][0].delay,120000);
    await h.tick();assert.equal([...h.timers.values()][0].delay,240000);
    await h.tick();assert.match(h.status.textContent,/Online/);assert.equal([...h.timers.values()][0].delay,60000);
});
test('invalid and empty samples are unavailable, not offline',async()=>{
    for(const csv of ['', 'time,on', 'time,on\ninvalid,1\n11/1/2026 12:00:00,NaN', '<html>error</html>']) {
        const h=setup([csv]);await flush();assert.match(h.status.textContent,/unavailable/);assert.equal(h.charts,0);assert.equal(h.timers.size,1);
    }
});
test('HTTP errors never render their body',async()=>{
    const h=setup([{ok:false,status:500,text:async()=>good}]);await flush();
    assert.match(h.status.textContent,/unavailable/);assert.equal(h.charts,0);
});
test('strict binary values, chronological order, and empty indicator',async()=>{
    const h=setup();await flush();
    const result=vm.runInContext("parseCSV('time,on\\n11/2/2026 12:00:00,0\\n11/1/2026 12:00:00,1\\ninvalid,1\\n11/1/2026 12:00:00,1junk\\n11/1/2026 12:00:00,')",h.context);
    assert.equal(result.length,2);assert.equal(result[1].on,0);
    vm.runInContext('updateStatusIndicator([])',h.context);assert.match(h.status.textContent,/unavailable/);
});
test('in-flight manual reload does not overlap; pagehide prevents rescheduling',async()=>{
    let resolve;
    const h=setup([()=>new Promise(r=>{resolve=r;})]);
    vm.runInContext('loadStatusPage()',h.context);
    assert.equal(h.requests,1);assert.equal(h.timers.size,0);
    h.events.pagehide();resolve({ok:true,text:async()=>good});await flush();
    assert.equal(h.timers.size,0);assert.equal(h.charts,0);
    h.events.pageshow();assert.equal(h.requests,2);
});
test('pagehide clears timer and chart',async()=>{
    const h=setup();await flush();h.events.pagehide();
    assert.equal(h.timers.size,0);assert.equal(h.destroyed,1);
});
