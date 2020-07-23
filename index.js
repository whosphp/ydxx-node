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

const global = {
    players: [],
    mid: '',
    monsters: {},
    battleCount: 0
}

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

                    const routes = [
                        ["connector.teamHandler.createdTeam", "createdTeam"],
                        ["connector.teamHandler.switchCombatScreen", "switchCombatScreen"],
                        ["connector.teamHandler.startCombat", "startCombat"],
                        ["connector.teamHandler.startCombatTower", "startCombatTower"],
                        ["connector.teamHandler.getTeamList", "getTeamList"]
                    ]
                    let routeHandlers = {}
                    routes.forEach(route => {
                        routeHandlers[route[1]] = function (params) {
                            params = params || {}

                            return new Promise((resolve, reject) => {
                                pomelo.request(route[0], params, function (data) {
                                    resolve(data)
                                })
                            })
                        }
                    })

                    // 创建队伍 获取场景 选择场景 开始战斗

                    pomelo.on("onStartBat", res => {
                        res.data.initData.map(m => {
                            if (m.is_palyer !== true) {
                                global.monsters[m._id] = m
                            }
                        })
                    })

                    pomelo.on("onRoundBatEnd", res => {
                        if (res.data.win > 0) {
                            global.battleCount++
                        }
                    })

                    async function crawlerMonsters() {
                        let res

                        // 获取场景
                        res = await routeHandlers.getTeamList({ mid: global.mid})
                        let screens = res.data.screens

                        // 创建队伍
                        await routeHandlers.createdTeam({mid: global.mid})

                        for (let i = 0; i < screens.length; i++) {
                            let screen = screens[i]
                            // 排除副本
                            if (["每日冒险", "藏宝图"].includes(screen.name)) {
                                continue
                            }

                            // 切换场景
                            await routeHandlers.switchCombatScreen({cbatid: screen._id})

                            // 每个场景战斗5次
                            for (let j = 0; j < 5; j++) {
                                let currentBattleCount = global.battleCount
                                await routeHandlers.startCombat({ cbatid: screen._id})
                                while (global.battleCount === currentBattleCount) {
                                    await sleep(8100)
                                }
                            }
                        }
                    }


                    let user_id = res.data.myInfo._id

                    logger.debug(res.data)
                    logger.debug(Object.keys(res.data))
                    logger.debug(res.data.map)

                    global.mid = res.data.map.id

                    if (true) {
                        routeHandlers.getTeamList({ mid: global.mid})
                            .then(res => {
                                let screens = {}
                                res.data.screens.map(s => {
                                    screens[s._id] = s
                                })

                                fs.outputFile('public/screens.json', JSON.stringify(screens), err => {
                                    if (err) {
                                        logger.warn(err)
                                    } else {
                                        logger.info("generate screens.json success")
                                    }
                                })
                            })
                    }


                    if (false) {
                        crawlerMonsters().then(function () {
                            fs.outputFile('public/monsters.json', JSON.stringify(global.monsters), err => {
                                if (err) {
                                    logger.warn(err)
                                }
                            })
                        })
                    }

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

                    // discoverMapsTask()

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