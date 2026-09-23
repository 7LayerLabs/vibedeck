'use strict';
const crypto = require('node:crypto');
function localAccess(token, getPort) {
  const cookieName = 'vibedeck_session';
  const valid = req => {
    const port = getPort();
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return false;
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return false;
    const value = (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1) || '';
    return /^[a-f0-9]{64}$/.test(value) && value.length === token.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));
  };
  const middleware = (req,res,next) => {
    res.setHeader('X-Frame-Options','SAMEORIGIN');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'");
    if(req.path==='/session' && req.query.token===token && [`127.0.0.1:${getPort()}`,`localhost:${getPort()}`].includes(req.headers.host) && !req.headers.origin) {
      res.cookie(cookieName,token,{httpOnly:true,sameSite:'strict',path:'/'}); return res.redirect('/');
    }
    if(!valid(req)) return res.status(403).send('Open VibeDeck from its desktop application or the session link printed at startup.');
    next();
  };
  return {valid,middleware};
}
module.exports={localAccess};
