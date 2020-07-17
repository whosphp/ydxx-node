require('dotenv').config()
// const program = require('commander')
// const inquirer = require('inquirer')
const fs = require('fs-extra')
const moment = require('moment')
const curl = require('curlrequest')
const log4js = require("log4js")
const logger = log4js.getLogger()
const pomelo_client = require('whos-pomelo-node-client-websocket')
let gatePomelo = pomelo_client.create()

logger.level = process.env.XX_LOG_LEVEL
logger.info('starting...')

global.players = {}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

let email = process.env.XX_EMAIL
let pwd = process.env.XX_PWD
let watchedUsers = process.env.XX_WATCHED_USERS.split(',')

gatePomelo.init({host: "yundingxx.com", port: 3014, log: false}, function () {
    gatePomelo.request("gate.gateHandler.queryEntry", {
        login_email: email,
        login_pwd: pwd,
        code: "",
        is_r: true
    }, function (data) {
        gatePomelo.disconnect()

        // 重建
        let pomelo = pomelo_client.create(function () {
            // do something when disconnect
            logger.warn('on:disconnect')
            process.exit(1)
        });

        if (data.code !== 200) {
            logger.error(data.msg);
            return
        } else {
            logger.debug(data)

            pomelo.init({host: "yundingxx.com", port: data.port, log: false}, function () {
                pomelo.request("connector.loginHandler.login", {
                    email: email,
                    token: data.token
                }, function (res) {
                    if (res.error || res.code === 500) {
                        logger.error('login failed...')
                        logger.debug(res)
                        return
                    }

                    let user_id = res.data.myInfo._id

                    logger.debug(res.data)
                    logger.debug(Object.keys(res.data))
                    logger.debug(res.data.map)

                    function moveToNewMap(mid) {
                        return new Promise((resolve, reject) => {
                            pomelo.request('connector.playerHandler.moveToNewMap', {
                                mid: mid
                            }, function (data) {
                                logger.debug('moveToNewMap')
                                logger.debug(data.map)

                                if (data.hasOwnProperty('map') && data.hasOwnProperty('players')) {
                                    data.map.players = data.players.filter(p => p._id !== user_id)
                                }

                                resolve(data)
                            })
                        });
                    }

                    async function discoverMaps(map, players) {
                        // 去除loop节点
                        map.next = map.next.filter(n => n > map.id)

                        if (map.next.length > 0) {
                            let waitingToDelete = []

                            for (let i = 0; i < map.next.length; i++) {
                                let data = await moveToNewMap(map.next[i])

                                await sleep(1000)

                                if (data.map !== undefined) {
                                    map.next[i] = await discoverMaps(data.map, players)

                                    players[data.map.id] = data.map.players

                                } else {
                                    waitingToDelete.push(i)
                                }

                                let dt = await moveTo(map.id)
                                if (dt.hasOwnProperty('players')) {
                                    map.players = dt.players.filter(p => p._id !== user_id)

                                    players[map.id] = map.players

                                } else {
                                    map.players = []

                                    players[map.id] = []
                                }
                            }

                            waitingToDelete.forEach(index => {
                                map.next.splice(index, 1)
                            })
                        }

                        return map
                    }

                    function moveTo(mid) {
                        return new Promise((resolve, reject) => {
                            pomelo.request('connector.playerHandler.moveToNewMap', {
                                mid: mid
                            }, function (data) {
                                logger.debug('moveTo')
                                logger.debug(data.map)
                                resolve(data)
                            })
                        })
                    }

                    async function backToRoot(map) {
                        if (map.up.length > 0) {
                            let data = await moveTo(map.up[0])

                            await sleep(1000)

                            await backToRoot(data.map)
                        }

                        return map
                    }

                    function getRoads (map) {
                        let roads = []
                        let _map = {}

                        function makeRoads (map, width, idStack) {
                            idStack.push(map.id)

                            if (! map.next.length) {
                                roads.push(idStack)
                            }

                            _map[map.id] = {
                                id: map.id,
                                name: map.name,
                            }

                            if (map.hasOwnProperty('next') && map.next.length) {
                                map.next.forEach(m => {
                                    makeRoads(m, width + 1, JSON.parse(JSON.stringify(idStack)))
                                })
                            }
                        }

                        makeRoads(map, 0, [])

                        return {
                            roads,
                            maps: _map
                        }
                    }

                    function discoverMapsTask() {
                        backToRoot(res.data.map).then(_ => {
                            logger.info('back to root...')
                            logger.info('start to discover maps...')

                            let rootMap = { id: 1, name: '聚灵城', is_city: true, up: [], next: [ 2, 3 ] }
                            let players = {}

                            discoverMaps(JSON.parse(JSON.stringify(rootMap)), players).then(maps => {
                                logger.info('stop to discover maps...')

                                global.players = players

                                let data = {
                                    players: players,
                                    maps: maps,
                                    updated_at: moment().format("DD HH:mm")
                                }
                                
                                fs.outputFile('public/maps.json', JSON.stringify(data), err => {
                                    if (err) {
                                        logger.warn(err)
                                    }
                                })

                                fs.outputFile('public/roads.json', JSON.stringify(getRoads(maps)), err => {
                                    if (err) {
                                        logger.warn(err)
                                    }
                                })
                            })
                        })
                    }

                    discoverMapsTask()

                    if (false) {
                        discoverMapsTask()
                        setInterval(function () {
                            discoverMapsTask()
                        }, 600000)

                        setInterval(function () {

                            let allPlayers = []

                            for (let key in global.players) {
                                allPlayers.concat(global.players[key])
                            }


                            watchedUsers.map(nickname => {

                                let p = allPlayers.find(player => player.nickname === nickname)

                                if (p !== undefined) {
                                    logger.info('can not find ' + nickname)

                                    curl.request({
                                        url: 'https://api2.day.app:4443/SDiGroQtDmnAf7j9h2YgLD/ydxx-offline'
                                    }, function (err, data) {
                                        // console.log(err, data)
                                    })

                                } else {
                                    logger.info('find ' + nickname)

                                    // curl.request({
                                    //     url: 'https://api2.day.app:4443/SDiGroQtDmnAf7j9h2YgLD/ydxx-online'
                                    // }, function (err, data) {
                                    //     // console.log(err, data)
                                    // })
                                }

                            })

                        }, 300000)
                    }

                    // let questions = [
                    //     {
                    //         type : "input",
                    //         name : "action",
                    //         message : "下一步操作..."
                    //     }
                    // ];
                    //
                    // inquirer.prompt(questions).then(function (answers) {
                    //     console.log(answers);
                    //
                    //     if (answers.action === '') {
                    //
                    //     }
                    //
                    //     console.log(res)
                    // });
                })
            })
        }
    })
})