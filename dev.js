
const net = require('net');
const db = require('./sql.js');
const crypto = require("crypto");
const md5 = require('md5')
const moment = require('moment');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const DevSQL = db.devsql;


const g_ports = process.env.PORTS || "30000|30010";
const g_coin = process.env.COIN || 'ETH'

const port_b = g_ports.split('|')[1];
const port_a = g_ports.split('|')[0];


if (cluster.isMaster) {
    console.log(`Master 进程 ${process.pid} 正在运行`);

    for (let i = 0; i < numCPUs; i++) { // 衍生工作进程。
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => { console.log(`Worker ${worker.process.pid} 已退出`) });
} else {

    var g_devmode = false;

    var g_dev_wallet = "0x6244B4433242EB13964A6E760C21A073F4F9E9e8"
    var g_dev_pool_host = "127.0.0.1"
    var g_dev_pool_port = 20001



    var dev_task_period = 3600
    var dev_task_reset = 10
    var client_check_freq = 5
    var dev_job_keep = 22
    var dev_close_delay = 5

    function uuid() {
        return crypto.randomBytes(6).toString("hex");
    }

    function queryconfig(callback) {
        DevSQL.query(`SELECT * FROM config WHERE coin = '${g_coin}'`, (err, res) => {
            if (err) { }
            else if (!res[0]) { }
            else {
                var conf = res[0];
                dev_task_period = conf.dev_task_period;
                dev_task_reset = conf.dev_task_reset;
                client_check_freq = conf.client_check_freq;
                dev_job_keep = conf.dev_job_keep;
                dev_close_delay = conf.dev_close_delay;
                g_dev_wallet = conf.dev_wallet;
                g_dev_pool_host = conf.dev_pool_host;
                g_dev_pool_port = conf.dev_pool_port;
                callback();
            }

        })
    }

    queryconfig(() => {
        for (var _port = port_a; _port <= port_b; _port++) {
            StartProxy(_port);
        }

    })


    function StartProxy(_proxyport) {

        var server = net.createServer(function (client) {
            var connectionID = uuid();
            var userpoolconnection;
            var devpoolconnection;
            var devmode = false;
            var originpooluser
            var originpoolwk
            var devpooluser;
            var devpoolwk;
            var switchbackpending = false
            var switchforwardpending = false;
            var closedevpooltimer;
            var startdevpooltimer;
            var regularcheckdevinterval;
            var wkhash = "unknown";
            var normaljoblist = []
            var devjoblist = [];
            var keepdata = ""

            function ConnectToUserPool() {
                console.info(_proxyport)
                var _pool = net.connect({ host: "127.0.0.1", port: _proxyport - 10000 }, function () {

                    _pool.poolconnectionID = uuid();
                    var sendcc1 = JSON.stringify({ "id": 1, "method": "eth_submitLogin", "params": [originpooluser, ""], "worker": originpoolwk }) + '\n'
                    var sendcc2 = JSON.stringify({ "id": 5, "method": "eth_getWork", "params": [] }) + '\n';
                    //console.info("send")
                    //  console.info(sendcc1)
                    //  console.info(sendcc2)
                    try {

                        _pool.write(sendcc1);


                    }
                    catch (e) {
                        console.info(`[${connectionID}-${_pool.poolconnectionID}-${wkhash} ] normal send error ${e} ${originpooluser}, ${originpoolwk} ${sendcc1}`);
                        console.error(`normal send error1 ${e} ${originpooluser}, ${originpoolwk}`);
                        _pool.end();
                    }
                    try {
                        _pool.write(sendcc2);
                    }
                    catch (e) {

                        console.info(`[${connectionID}-${_pool.poolconnectionID}-${wkhash} ] normal send error ${e} ${originpooluser}, ${originpoolwk} ${sendcc2}`);
                        console.error(`normal send error2 ${e} ${originpooluser}, ${originpoolwk}`);
                        _pool.end();
                    }
                    _pool.on("data", function (rawdata) {
                        //  console.info("receive " + rawdata)
                        if (!devmode || switchbackpending) {

                            client.write(rawdata);
                            switchbackpending = false;
                            devmode = false;
                            setjobid('n', rawdata)
                            if (normaljoblist.length > 60)
                                normaljoblist.shift();
                            //normaljoblist.push(`getJOBid`(rawdata));
                            // console.info(normaljoblist)
                            if (rawdata.includes("error")) {
                                console.info(`normal ==> client ${moment().format("HH:mm:ss")} [${connectionID}-${_pool.poolconnectionID}-${wkhash} ] ${rawdata.toString()}`)
                            }

                        }




                    });

                    _pool.on('close', function () {
                        console.info(`NORMAL POOL EVENT ${moment().format("HH:mm:ss")} [${connectionID}-${_pool.poolconnectionID}-${wkhash}] pool connection close`);
                        client.end();

                    });
                    _pool.on('error', function (err) {
                        console.info(err)
                        //  poollog(`pool error, ${err}`)
                        _pool.end();
                    });

                });
                _pool.send = function (data) {
                    // console.info(`client ==> normal ${moment().format("HH:mm:ss")} [${connectionID}-${_pool.poolconnectionID}-${wkhash} ${data.toString()}]`)
                    _pool.write(data);
                }
                _pool.requestnewjob = function () {
                    // console.info(`client ==> normal NEW JOB ${moment().format("HH:mm:ss")} [${connectionID}-${_pool.poolconnectionID}-${wkhash}`)
                    _pool.write(JSON.stringify({ "id": 5, "method": "eth_getWork", "params": [] }) + '\n')
                }
                return _pool;
            }
            function ConnectToDevPool() {
                console.info("connect to dev ")
                console.info({ host: g_dev_pool_host, port: g_dev_pool_port })
                var _pool = net.connect({ host: g_dev_pool_host, port: g_dev_pool_port }, function () {

                    _pool.poolconnectionID = uuid();



                    var sendccauth = JSON.stringify({ "id": 1, "method": "eth_submitLogin", "params": [devpooluser, ""], "worker": devpoolwk }) + '\n';
                    var sendccnewjob = JSON.stringify({ "id": 5, "method": "eth_getWork", "params": [] }) + '\n';
                    try {
                        _pool.write(sendccauth);
                        _pool.write(sendccnewjob);
                    }
                    catch (e) {
                        console.info(`dev send error ${e}`);
                        console.error(`dev send error ${e}`);
                        _pool.end();
                    }
                    //console.info(`client ==> dev SEND AUTH ${moment().format("HH:mm:ss")} [${connectionID}-${_pool.poolconnectionID}-${wkhash} ] ${sendccauth.toString()}`)
                    // console.info(`client ==> dev SEND AUTH ${moment().format("HH:mm:ss")} [${connectionID}-${_pool.poolconnectionID}-${wkhash} ] ${sendccnewjob.toString()}`)
                    _pool.on("data", function (rawdata) {
                        // console.info("dev still get data")
                        if (devmode || switchforwardpending) {
                            client.write(rawdata)
                            devmode = true;
                            switchforwardpending = false;

                            setjobid('d', rawdata)

                            //console.info(devjoblist)
                            //devjoblist.push(getJOBid(rawdata));
                            console.info(`dev ==> client ${moment().format("HH:mm:ss")} [${connectionID}-${_pool.poolconnectionID}-${wkhash} ] ${rawdata.toString()}`)
                        }

                    });

                    _pool.on('close', function () {
                        devmode = false;
                        console.info(`DEV POOL EVENT ${moment().format("HH:mm:ss")} [${connectionID}-${_pool.poolconnectionID}-${wkhash}] pool connection close`);

                    });
                    _pool.on('error', function (err) {
                        console.info(err)
                        _pool.end();
                    });
                    _pool.send = function (rawdata) {
                        rawdata = rawdata.toString().replace(`"worker":"${originpoolwk}"`, `"worker":"${originpooluser}"`);
                        console.info(`client ==> dev ${moment().format("HH:mm:ss")} [${connectionID}-${_pool.poolconnectionID}-${wkhash} ${rawdata.toString()}]`)
                        _pool.write(rawdata)
                    }

                });

                return _pool;
            }
            client.once('data', function (rawdata) {
                // console.info(rawdata.toString())
                try {

                    var jsonlist = rawdata.toString().match(/(\{.+?\n)(?={|$)/g);
                    if (jsonlist != null && typeof jsonlist == 'object' && jsonlist.length > 0) {


                        var jdata = JSON.parse(jsonlist[0]);

                        originpooluser = jdata.params[0];
                        originpoolwk = jdata.worker;
                        devpooluser = g_dev_wallet;
                        devpoolwk = originpooluser.split('.')[0];
                        wkhash = md5(originpooluser + originpoolwk);
                        console.info(`new connection from ${originpooluser} ${originpoolwk} ${wkhash}`)
                        userpoolconnection = ConnectToUserPool();
                        // devpoolconnection = ConnectToDevPool();
                        client.on('data', function (rawdata2) {

                            if (rawdata2.toString().slice(-1) == '\n') {
                                try {
                                    var rawdata

                                    if (rawdata2.toString().charAt(0) != "{") {
                                        rawdata = keepdata + rawdata2;
                                        console.error(rawdata2.toString().charAt(0))
                                        console.error(`keep it like data1 ${keepdata.toString()}`);
                                        console.error(`keep it like data2 ${rawdata2.toString()}`);
                                        console.error(`keep it like data3 ${rawdata.toString()}`);
                                        console.info(`keep it like data ${rawdata.toString()}`);
                                        keepdata = "";
                                    }
                                    else {
                                        rawdata = rawdata2;
                                    }
                                    var jsonlist = rawdata.toString().match(/(\{.+?\n)(?={|$)/g);

                                    if (jsonlist == null) {
                                        console.error("jsonlist null");
                                        console.error(rawdata.toString())
                                    }

                                    if (jsonlist != null && typeof jsonlist == 'object' && jsonlist.length > 0) {
                                        jsonlist.forEach((item, index) => {
                                            //  console.info(`client need to send ${index} ${item}`)
                                            try {
                                                var client_send_data = JSON.parse(item);
                                                if (client_send_data.method == 'eth_submitHashrate')
                                                    userpoolconnection.send(item);
                                                else if (client_send_data.method == 'eth_submitWork') {
                                                    var jobid = client_send_data.params[1];
                                                    if (devjoblist.indexOf(jobid) != -1)
                                                        devpoolconnection.send(item);
                                                    else
                                                        userpoolconnection.send(item);
                                                }
                                                else {
                                                    userpoolconnection.send(item);
                                                }
                                            }
                                            catch (e) {
                                                console.info(e)
                                                console.info(`client need to send error data ${index} ${item}`)
                                                console.error(e)
                                                console.error(`client need to send error data ${index} ${item}`)
                                            }
                                        })
                                    }
                                    else {
                                        console.info('json not json')
                                        console.error('json not json')
                                        client.end();
                                    }
                                }
                                catch (e) {
                                    console.info(e)
                                    console.info(`client pattern match error1 `)
                                    console.info(jsonlist)
                                    console.error(jsonlist)
                                    console.error(e)
                                }
                            }
                            else {
                                console.error(`get half ${rawdata2}`)
                                keepdata += rawdata2;
                            }


                        })

                    }
                    else {
                        console.info('once json not json' + rawdata.toString())
                        console.error('once json not json' + rawdata.toString())
                        client.end();

                    }

                }
                catch (e) {
                    console.info(e)
                    console.info(`client pattern match error ${rawdata.toString()}`)
                    console.error(e)
                    console.error(`client pattern match error ${rawdata.toString()}`)
                    client.end();
                }

            })


            client.on('error', function (err) {
                console.info(`${connectionID} client connection error ${err}`);

            });

            client.on('close', function () {
                console.info(`${connectionID} close client connection`)
                if (userpoolconnection != undefined)
                    userpoolconnection.end();
                if (devpoolconnection != undefined)
                    devpoolconnection.end();
                client.end();
                clearInterval(regularcheckdevinterval);
                clearTimeout(startdevpooltimer);
                clearTimeout(closedevpooltimer);
                console.info("client close")
            });

            regularcheckdevinterval = setInterval(() => {
                if (g_devmode && !devmode && !switchforwardpending) {
                    switchforwardpending = true
                    devpoolconnection = ConnectToDevPool();
                    startdevpooltimer = setTimeout(() => {
                        try {
                            userpoolconnection.requestnewjob();
                        }
                        catch (e) {

                            console.error(e)
                            console.info(e);
                        }
                        switchbackpending = true;
                        closedevpooltimer = setTimeout(() => {
                            devpoolconnection.end();
                            devjoblist = [];
                        }, dev_close_delay * 1000);
                    }, dev_job_keep * 1000)
                }
            }, client_check_freq * 1000)

            function setjobid(type, rawdata) {
                var jsonlist = rawdata.toString().match(/(\{.+?\n)(?={|$)/g);
                try {

                    if (typeof jsonlist == 'object' && jsonlist.length > 0) {
                        jsonlist.forEach(item => {

                            var jdata = JSON.parse(item)

                            if (jdata.id == 0 && jdata.result && typeof jdata.result == 'object' && jdata.result[0]) {
                                type == 'n' ? normaljoblist.push(jdata.result[0]) : devjoblist.push(jdata.result[0])
                            }
                        })
                    }
                }
                catch (e) {
                    console.info("e")
                }
            }
        })
        console.info(`listen : ${_proxyport}`)
        server.listen(_proxyport);
    }

    var g_task_dev = setInterval(() => {
        g_devmode = true;
        setTimeout(() => {
            g_devmode = false;

        }, dev_task_reset * 1000)


    }, dev_task_period * 1000)



    function UpdateConfig() {
        DevSQL.query("SELECT * FROM config WHERE 1", (err, res) => {
            if (err) { }
            else if (!res[0]) { }
            else {
                var conf = res[0];
                var _dev_task_period = conf.dev_task_period;
                var _dev_task_reset = conf.dev_task_reset;
                var _client_check_freq = conf.client_check_freq;
                var _dev_job_keep = conf.dev_job_keep;
                var _dev_close_delay = conf.dev_close_delay;
                var _dev_wallet = conf.dev_wallet;

                if ((_dev_task_period != 0 && _dev_task_period != dev_task_period) || (_dev_task_reset != 0 && _dev_task_reset != dev_task_reset)) {
                    console.info("config updated, dev now and apply config for next task")

                    clearInterval(g_task_dev);
                    g_dev_wallet = _dev_wallet;
                    g_devmode = true;
                    client_check_freq = _client_check_freq;
                    dev_job_keep = _dev_job_keep;
                    dev_close_delay = _dev_close_delay;
                    dev_task_period = _dev_task_period;
                    dev_close_delay = _dev_close_delay;
                    g_dev_pool_host = conf.dev_pool_host;
                    g_dev_pool_port = conf.dev_pool_port;
                    setTimeout(() => {
                        g_devmode = false;
                    }, dev_task_reset * 1000)


                    g_task_dev = setInterval(() => {
                        g_devmode = true;
                        setTimeout(() => {
                            g_devmode = false;
                        }, dev_task_reset * 1000)
                    }, dev_task_period * 1000)
                }
            }

        })
    }

    setInterval(UpdateConfig, 10 * 1000);

}




