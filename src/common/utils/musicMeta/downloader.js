const http = require('http')
const https = require('https')
const fs = require('fs')
const { pipeline } = require('stream/promises')
const { httpOverHttp, httpsOverHttp } = require('tunnel')

const httpsRxp = /^https:/
const getRequestAgent = (url, proxy) => {
  return proxy ? (httpsRxp.test(url) ? httpsOverHttp : httpOverHttp)({ proxy }) : undefined
}

const sendRequest = (url, proxy) => {
  const urlParse = new URL(url)
  const httpOptions = {
    method: 'get',
    host: urlParse.hostname,
    port: urlParse.port,
    path: urlParse.pathname + urlParse.search,
    agent: getRequestAgent(url, proxy),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
    },
  }

  // console.log(httpOptions)
  return urlParse.protocol === 'https:'
    ? https.request(httpOptions)
    : http.request(httpOptions)
}

module.exports = async(url, filePath, proxy) => {
  let response
  let hasFile = false
  try {
    response = await new Promise((resolve, reject) => {
      const request = sendRequest(url, proxy).on('response', resolve).on('error', reject)
      request.setTimeout(20_000, () => { request.destroy(new Error('Cover download timeout')) })
      request.end()
    })
    if (response.statusCode !== 200 && response.statusCode !== 206) {
      response.destroy()
      return false
    }
    hasFile = true
    await pipeline(response, fs.createWriteStream(filePath))
    if (!response.complete) throw new Error('Incomplete cover download')
    return true
  } catch (error) {
    response?.destroy()
    if (hasFile) {
      await fs.promises.unlink(filePath).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    }
    return false
  }
}

// const url = 'https://y.gtimg.cn/music/photo_new/T002R500x500M000000nfgwP0D6qxd.jpg'
// // const url = 'http://p4.music.126.net/-U2K8GKlASCSXK0cRre1gA==/109951163188718762.jpg'
// const picPath = require('path').join(__dirname, 'test.jpg')
// module.exports(url, picPath).then((sucee) => {
//   console.log(sucee)
// })
