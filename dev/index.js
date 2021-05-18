const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const Blockchain = require("./blockchain");
const uuid = require("uuid/v1"); //for keys
const uniqid = require("uniqid"); //for invitations
const rp = require("request-promise");
var path = require("path");
var validator = require("validator");
const sha256 = require("sha256");
const fs = require("fs");
const MongoClient = require("mongodb").MongoClient;
const http = require("http");
var server = http.createServer(app);
var nodemailer = require("nodemailer");
var forge = require("node-forge");
const moment = require("moment");
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; //fixing nodemailer

app.set("view engine", "ejs");

const port = process.env.PORT || process.argv[2];

app.use(express.static(path.join(__dirname, "Front"))); //public
app.use("/styles", express.static(__dirname + "/Front/assets")); //allow css in invitation page (public)

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

server = app.listen(port, function () {
  console.log("listening to port: " + port);
});

///////////////////////////////////////////////////////////////////////////////////////////////
/*  -find index of socket | For example : search((socket.id).toString(), nodes);-  */
///////////////////////////////////////////////////////////////////////////////////////////////
function search(nameKey, myArray) {
  for (var i = 0; i < myArray.length; i++) {
    if (myArray[i].socketId === nameKey) {
      return i;
    }
  }
}
////////////////////////////////////////// ~@ -Start socket.io- @~ //////////////////////////////////////////
var io = require("socket.io")(server);

/*  -Socket.io-  */
io.on("connection", (socket) => {
  /*  -On connection of socket-  */
  // socket.emit("PT", backup.pendingTransactions); //emit to that specific socket
  console.log("New user connected");
  console.log(socket.id);

  /*
   * Title: Broadcast Transanction section
   * Description: Init transaction for every endpoint.
   */
  app.post("/transaction/broadcast", (req, res) => {
    const amount = parseFloat(req.body.amount);
    let flag = true;
    let sender = req.body.sender;
    let recipient = req.body.recipient;
    let backup;
    const nodes = [];

    const blockChains = JSON.parse(
      fs.readFileSync("data/block-chains.json", "utf8")
    );

    blockChains.forEach((e) => {
      nodes.push(
        new Blockchain(
          e.privateKey,
          e.publicKey,
          e.chain,
          e.pendingTransactions,
          e.currentNodeUrl
        )
      );
    });

    if (sender === "system-reward" || sender === "system-reward: new user") {
      const blockChain = JSON.parse(
        fs.readFileSync(`data/backup/${recipient}.json`, "utf8")
      );

      backup = new Blockchain(
        blockChain.privateKey,
        blockChain.publicKey,
        blockChain.chain,
        blockChain.pendingTransactions,
        blockChain.currentNodeUrl
      );
    } else {
      const blockChain = JSON.parse(
        fs.readFileSync(`data/backup/${sender}.json`, "utf8")
      );

      backup = new Blockchain(
        blockChain.privateKey,
        blockChain.publicKey,
        blockChain.chain,
        blockChain.pendingTransactions,
        blockChain.currentNodeUrl
      );
    }

    const newTransaction = nodes[nodes.length - 1].createNewTransaction(
      amount,
      req.body.sender,
      req.body.recipient
    );

    /*  -Authentication: check for valid private key-  */
    if (sender !== "system-reward" && sender !== "system-reward: new user") {
      const privateKey_Is_Valid = sha256(req.body.privKey) === req.body.sender;
      if (!privateKey_Is_Valid) {
        flag = false;
        res.json({
          note: false,
        });
      }
      /*  -Authentication: check if user have the require amount of coins for current transaction && if user exist in the blockchain-  */
      const addressData = backup.getAddressData(req.body.sender);
      const addressData1 = backup.getAddressData(req.body.recipient);
      if (
        addressData.addressBalance < amount ||
        addressData === false ||
        addressData1 === false
      ) {
        flag = false;
        res.json({
          note: false,
        });
      }
      /*  -Authentication: fields cannot be empty-  */
      if (
        req.body.amount.length === 0 ||
        amount === 0 ||
        amount < 0 ||
        req.body.sender.length === 0 ||
        req.body.recipient.length === 0
      ) {
        flag = false;
        res.json({
          note: false,
        });
      }
    }

    if (amount > 0 && flag === true) {
      var pt = null;
      backup.addTransactionToPendingTransactions(newTransaction); //put new transaction in global object

      console.log({ backup });

      nodes.forEach((node) => {
        node.addTransactionToPendingTransactions(newTransaction);

        fs.writeFile(
          `data/backup/${node.publicKey}.json`,
          JSON.stringify(node),
          function (err) {
            if (err) throw err;
            console.log("write back up block chain complete!");
          }
        );
        pt = node.pendingTransactions;
      });
      io.clients().emit("PT", pt); //emit to all sockets

      fs.writeFile(
        "data/block-chains.json",
        JSON.stringify(nodes),
        function (err) {
          if (err) throw err;
          console.log("write block chains complete!");
        }
      );

      if (sender === "system-reward" || sender === "system-reward: new user") {
        fs.writeFile(
          `data/backup/${recipient}.json`,
          JSON.stringify(backup),
          function (err) {
            if (err) throw err;
            console.log("write back up block chain complete!");
          }
        );

        res.json({
          note: `Transaction complete!`,
        });
      } else {
        fs.writeFile(
          `data/backup/${sender}.json`,
          JSON.stringify(backup),
          function (err) {
            if (err) throw err;
            console.log("write back up block chain complete!");
          }
        );

        res.json({
          note: `Transaction complete!`,
        });
      }
    }
  });

  /*
   * Title: Miner section
   * Description: user mine the last block of transaction by POW, getting reward and init a new block
   */
  app.get("/mine/:address", (req, res) => {
    const address = req.params.address;
    const blockchain = JSON.parse(
      fs.readFileSync(`data/backup/${address}.json`, "utf8")
    );

    const {
      privateKey,
      publicKey,
      chain,
      pendingTransactions,
      currentNodeUrl,
    } = blockchain;

    const backup = new Blockchain(
      privateKey,
      publicKey,
      chain,
      pendingTransactions,
      currentNodeUrl
    );

    const lastBlock = backup.getLastBlock();
    const previousBlockHash = lastBlock["hash"];

    const currentBlockData = {
      transactions: backup.pendingTransactions,
      index: lastBlock["index"] + 1,
    };

    const nonce = backup.proofOfWork(previousBlockHash, currentBlockData); //doing a proof of work
    const blockHash = backup.hashBlock(
      previousBlockHash,
      currentBlockData,
      nonce
    ); //hash the block
    const newBlock = backup.createNewBlock(nonce, previousBlockHash, blockHash); //create a new block with params

    const requestOptions = {
      //a promise to make a new block
      uri: backup.currentNodeUrl + `/receive-new-block/${address}`,
      method: "POST",
      body: { newBlock: newBlock },
      json: true,
    };
    rp(requestOptions)
      .then((data) => {
        //reward the miner after mining succed and new block already created
        const requestOptions = {
          uri: backup.currentNodeUrl + "/transaction/broadcast",
          method: "POST",
          body: {
            amount: 12.5,
            sender: "system-reward",
            recipient: address,
          },
          json: true,
        };
        return rp(requestOptions);
      })
      .then((data) => {
        res.json({
          note: "New block mined and broadcast successfully",
          block: newBlock,
        });
      });
  });

  /*
   * Title: receive new block section
   * Description: checking validity of new block.
   */
  app.post("/receive-new-block/:address", (req, res) => {
    const address = req.params.address;
    const nodes = [];

    const blockChains = JSON.parse(
      fs.readFileSync("data/block-chains.json", "utf8")
    );

    blockChains.forEach((e) => {
      nodes.push(
        new Blockchain(
          e.privateKey,
          e.publicKey,
          e.chain,
          e.pendingTransactions,
          e.currentNodeUrl
        )
      );
    });

    const blockchain = JSON.parse(
      fs.readFileSync(`data/backup/${address}.json`, "utf8")
    );

    const {
      privateKey,
      publicKey,
      chain,
      pendingTransactions,
      currentNodeUrl,
    } = blockchain;

    const backup = new Blockchain(
      privateKey,
      publicKey,
      chain,
      pendingTransactions,
      currentNodeUrl
    );

    const newBlock = req.body.newBlock;
    const lastBlock = backup.getLastBlock();
    const correctHash = lastBlock.hash === newBlock.previousBlockHash;
    const correctIndex = lastBlock["index"] + 1 === newBlock["index"];

    if (correctHash && correctIndex) {
      backup.chain.push(newBlock);
      backup.pendingTransactions = [];

      nodes.forEach((e) => {
        e.chain.push(newBlock);
        e.pendingTransactions = [];

        fs.writeFile(
          `data/backup/${e.publicKey}.json`,
          JSON.stringify(e),
          function (err) {
            if (err) throw err;
            console.log("write back up block chain complete!");
          }
        );
      });

      fs.writeFile(
        `data/backup/${address}.json`,
        JSON.stringify(backup),
        function (err) {
          if (err) throw err;
          console.log("write back up block chain complete!");
        }
      );

      fs.writeFile(
        "data/block-chains.json",
        JSON.stringify(nodes),
        function (err) {
          if (err) throw err;
          console.log("write block chains complete!");
        }
      );

      res.json({
        note: "New block received and accepted.",
        newBlock: newBlock,
      });
    } else {
      res.json({
        note: "New block rejected",
        newBlock: newBlock,
      });
    }
  });

  /*
   * Title: emitMiningSuccess
   * Description: emit all sockets - a message to all sockets for mining operation succed
   */
  app.get("/emitMiningSuccess", (req, res) => {
    io.clients().emit("mineSuccess", true); //emit to all sockets
  });

  /*
   * Title: pendingTransactions
   * Description: get all pending Transactions
   */
  app.get("/pendingTransactions", (req, res) => {
    const transactionsData = backup.getPendingTransactions();
    res.json({
      pendingTransactions: transactionsData,
    });
  });

  /*
   * Title: Main Blockchain
   * Description: display the whole block chain (Developers Only!)
   */
  app.get("/blockchain", (req, res) => {
    res.send(backup);
  });

  /*
   * Title: generateKeyPair
   * Description: generateKeyPair
   */
  var keyPair = forge.pki.rsa.generateKeyPair(1024);
  app.get("/generateKeyPair", (req, res) => {
    res.send(keyPair.publicKey);
  });

  /*
   * Title: Authentication Keys
   * Description: Authentication for private and public keys
   */
  app.post("/hashKeys", (req, res) => {
    const k1 = req.body.key1;
    const k2 = req.body.key2;

    const privateKey_Is_Valid = sha256(k1) === k2;

    const blockchain = JSON.parse(
      fs.readFileSync(`data/backup/${k2}.json`, "utf8")
    );

    const {
      privateKey,
      publicKey,
      chain,
      pendingTransactions,
      currentNodeUrl,
    } = blockchain;

    const backup = new Blockchain(
      privateKey,
      publicKey,
      chain,
      pendingTransactions,
      currentNodeUrl
    );

    const addressData = backup.getAddressData(k2);
    if (addressData === false) {
      res.json({
        note: false,
      });
    } else if (!privateKey_Is_Valid) {
      res.json({
        note: false,
      });
    } else {
      res.json({
        note: true,
      });
    }
  });

  /*  -Chat: send message to all users-  */
  /*
   * Title: Chat - get new message
   * Description: get a message and emit it to all users
   */
  socket.on("getNewMessage", (message) => {
    //message = message.toString();
    //message = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    io.clients().emit("newMessage", message);
  });

  /*
   * Title: disconnect
   * Description: enabled when user logs off
   */
  socket.on("disconnect", () => {
    console.log(`User: ${socket.id} was disconnected`);
  });
});

/////////////////////////////////////////// ~@ -End socket.io- @~ ///////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////////////////////
app.post("/login", async (req, res) => {
  const password = req.body.password;
  const privateKey = req.body.privateKey;
  const publicKey = req.body.publicKey;

  ///////////////////////////////////////////////////////////////////////////////////////////////
  const rawUsers = fs.readFileSync("data/users.json", "utf8");
  const users = rawUsers !== "" ? JSON.parse(rawUsers) : [];

  const user = users.find(
    (e) =>
      e.privateKey === privateKey &&
      e.publicKey === publicKey &&
      e.password === password
  );
  ///////////////////////////////////////////////////////////////////////////////////////////////

  if (!user) {
    res.json({
      isAuth: false,
    });
  }

  ///////////////////////////////////////////////////////////////////////////////////////////////
  const rawBlockChains = fs.readFileSync("data/block-chains.json", "utf8");
  const blockChains = rawBlockChains !== "" ? JSON.parse(rawBlockChains) : [];

  const idxBlockChain = blockChains.findIndex(
    (e) => e.privateKey === privateKey && e.publicKey === publicKey
  );

  ///////////////////////////////////////////////////////////////////////////////////////////////

  if (idxBlockChain === -1) {
    res.json({
      isAuth: false,
    });
  }

  ///////////////////////////////////////////////////////////////////////////////////////////////

  let max = 0;
  let idxLongest = 0;
  blockChains.forEach((e, idx) => {
    const len = e.chain.length;

    if (len > max) {
      max = len;
      idxLongest = idx;
    }
  });

  if (blockChains[idxLongest].chain > blockChains[idxBlockChain].chain) {
    blockChains[idxLongest].chain.forEach((e) => {
      const idx = blockChains[idxBlockChain].chain.findIndex(
        (chain) => chain.index === e.index
      );

      if (idx === -1) {
        blockChains[idxBlockChain].chain.push(e);
      }
    });

    blockChains[idxBlockChain].pendingTransactions =
      blockChains[idxLongest].pendingTransactions;
  }

  fs.writeFile(
    "data/block-chains.json",
    JSON.stringify(blockChains),
    function (err) {
      if (err) throw err;
      console.log("write block chains complete!");
    }
  );

  fs.writeFile(
    `data/backup/${blockChains[idxBlockChain].publicKey}.json`,
    JSON.stringify(blockChains[idxBlockChain]),
    function (err) {
      if (err) throw err;
      console.log("write back up block chain complete!");
    }
  );

  res.json({
    isAuth: true,
    user: {
      privateKey,
      publicKey,
    },
    blockChain: {
      amount: 1000,
      lastBlock: "1234",
    },
  });
});

///////////////////////////////////////////////////////////////////////////////////////////////
app.post("/register", async (req, res) => {
  const password = req.body.password;
  const privateKey = uuid().split("-").join(""); //privateKey
  const publicKey = sha256(privateKey); //publicKey

  ///////////////////////////////////////////////////////////////////////////////////////////////
  const rawUsers = fs.readFileSync("data/users.json", "utf8");
  const users = rawUsers !== "" ? JSON.parse(rawUsers) : [];
  const newUser = { privateKey, publicKey, password };
  users.push(newUser);

  fs.writeFile("data/users.json", JSON.stringify(users), function (err) {
    if (err) throw err;
    console.log("write users complete!");
  });
  ///////////////////////////////////////////////////////////////////////////////////////////////

  const rawBlockChains = fs.readFileSync("data/block-chains.json", "utf8");
  const blockChains = rawBlockChains !== "" ? JSON.parse(rawBlockChains) : [];
  const blockChain = new Blockchain(privateKey, publicKey);

  let max = 0;
  let idxLongest = 0;

  if (blockChains.length > 0) {
    blockChains.forEach((e, idx) => {
      const len = e.chain.length;

      if (len > max) {
        max = len;
        idxLongest = idx;
      }
    });

    blockChain.chain = blockChains[idxLongest].chain;
    blockChain.pendingTransactions =
      blockChains[idxLongest].pendingTransactions;
  }

  ///////////////////////////////////////////////////////////////////////////////////////////////

  fs.writeFile(
    `data/backup/${publicKey}.json`,
    JSON.stringify(blockChain),
    function (err) {
      if (err) throw err;
      console.log("write back up block chain complete!");
    }
  );

  ///////////////////////////////////////////////////////////////////////////////////////////////
  blockChains.push(blockChain);
  fs.writeFile(
    "data/block-chains.json",
    JSON.stringify(blockChains),
    function (err) {
      if (err) throw err;
      console.log("write block chains complete!");
    }
  );
  ///////////////////////////////////////////////////////////////////////////////////////////////

  /*  -reward new user-  */
  const requestOptions1 = {
    uri: blockChain.currentNodeUrl + "/transaction/broadcast",
    method: "POST",
    body: {
      amount: 100,
      sender: "system-reward: new user",
      recipient: publicKey,
    },
    json: true,
  };
  rp(requestOptions1);

  res.json({
    note: true,
    newUser,
  });
});

///////////////////////////////////////////////////////////////////////////////////////////////
/*  -Getters-  */
///////////////////////////////////////////////////////////////////////////////////////////////

/*  -get block by blockHash-  */
app.get("/block/:blockHash", (req, res) => {
  const blockHash = req.params.blockHash;
  const correctBlock = backup.getBlock(blockHash);
  res.json({
    block: correctBlock,
  });
});

/*  -get transaction by transactionId-  */
app.get("/transaction/:transactionId", (req, res) => {
  const transactionId = req.params.transactionId;
  const trasactionData = backup.getTransaction(transactionId);
  res.json({
    transaction: trasactionData.transaction,
    block: trasactionData.block,
  });
});

/*  -get address by address-  */
app.get("/address/:address", (req, res) => {
  const address = req.params.address;
  const addressData = backup.getAddressData(address);
  res.json({
    addressData: addressData,
  });
});

/*  -get wallet info by address-  */
app.get("/address-info/:address", (req, res) => {
  const address = req.params.address;
  const blockchain = JSON.parse(
    fs.readFileSync(`data/backup/${address}.json`, "utf8")
  );

  const { privateKey, publicKey, chain, pendingTransactions, currentNodeUrl } =
    blockchain;

  const backup = new Blockchain(
    privateKey,
    publicKey,
    chain,
    pendingTransactions,
    currentNodeUrl
  );

  const addressData = backup.getAddressData(address);
  const lastBlock = backup.getLastBlock();

  res.json({
    amount: addressData.addressBalance,
    lastBlock: lastBlock.index,
  });
});

/*  -get lasted block by address-  */
app.get("/lasted-blocks", (req, res) => {
  const blockChains = JSON.parse(
    fs.readFileSync(`data/block-chains.json`, "utf8")
  );

  let max = 0;
  let idxLongest = 0;
  blockChains.forEach((e, idx) => {
    const len = e.chain.length;

    if (len > max) {
      max = len;
      idxLongest = idx;
    }
  });

  const blocks = [];

  const { chain } = blockChains[idxLongest];

  chain.forEach((e) => {
    blocks.push({
      idx: e.index,
      date: e.date,
      nonce: e.nonce,
      hash: e.hash,
      previousHash: e.previousBlockHash,
    });
  });

  res.json({
    blocks: blocks.reverse(),
  });
});

/*  -get lasted transactions  */
app.get("/lasted-transactions", (req, res) => {
  const blockChains = JSON.parse(
    fs.readFileSync(`data/block-chains.json`, "utf8")
  );

  let max = 0;
  let idxLongest = 0;
  blockChains.forEach((e, idx) => {
    const len = e.chain.length;

    if (len > max) {
      max = len;
      idxLongest = idx;
    }
  });

  let transactions = [];

  const { chain } = blockChains[idxLongest];

  chain.forEach((e) => {
    transactions = transactions.concat(e.transactions);
  });

  res.json({
    transactions: transactions.reverse(),
  });
});

/*  -get lasted transactions by address-  */
app.get("/lasted-transactions/:address", (req, res) => {
  const address = req.params.address;
  const blockChain = JSON.parse(
    fs.readFileSync(`data/backup/${address}.json`, "utf8")
  );

  let transactions = [];

  const { chain } = blockChain;

  chain.forEach((e) => {
    transactions = transactions.concat(e.transactions);
  });

  let mineTransactions = [];

  transactions.forEach((e) => {
    if (e.sender === address || e.recipient === address) {
      mineTransactions.push(e);
    }
  });

  res.json({
    transactions: mineTransactions,
  });
});

/*  -get pending transactions  */
app.get("/pending-transactions", (req, res) => {
  const blockChains = JSON.parse(
    fs.readFileSync(`data/block-chains.json`, "utf8")
  );

  let max = 0;
  let idxLongest = 0;
  blockChains.forEach((e, idx) => {
    const len = e.chain.length;

    if (len > max) {
      max = len;
      idxLongest = idx;
    }
  });

  const { pendingTransactions } = blockChains[idxLongest];

  res.json({
    pendingTransactions: pendingTransactions.reverse(),
  });
});

app.get("/Front", (req, res) => {
  res.sendFile("./Front/login.html", { root: __dirname });
});
