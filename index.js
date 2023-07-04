const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xeokx86.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true, } });

const verifyJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).send('Unauthorized access!');

    const token = authHeader.split(' ')[1];

    jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
        if (err) return res.status(403).send({ message: 'Forbidden access!' })
        req.decoded = decoded;
        next()
    })
}

const run = async () => {
    try {
        const appointmentOptionCollection = client.db('doctorsPortal').collection('appointmentOptions');
        const bookingsCollection = client.db('doctorsPortal').collection('bookings');
        const usersCollection = client.db('doctorsPortal').collection('users');
        const doctorsCollection = client.db('doctorsPortal').collection('doctors');
        const paymentsCollection = client.db('doctorsPortal').collection('payments');

        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            const user = await usersCollection.findOne({ email: decodedEmail });

            if (user?.role !== 'admin')
                return res.status(403).send({ message: 'Forbidden access!' });

            next();
        }

        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const options = await appointmentOptionCollection.find({}).toArray();
            const alreadyBooked = await bookingsCollection.find({ appointmentDate: date }).toArray();
            // just be careful :)
            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
                const bookedSlots = optionBooked.map(book => book.slot);
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = remainingSlots;
            })
            res.send(options);
        });

        app.get('/appointmentSpecialty', async (req, res) => {
            const result = await appointmentOptionCollection.find({}).project({ name: 1 }).toArray();
            res.send(result);
        })
 
        // get my bookings
        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;
            if (email !== decodedEmail)
                return res.status(403).send({ message: 'Forbidden access!' })
            const bookings = await bookingsCollection.find({ email }).toArray();
            res.send(bookings);
        });

        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const result = await bookingsCollection.findOne({ _id: new ObjectId(id) });
            res.send(result);
        })

        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            };

            const alreadyBooked = await bookingsCollection.find(query).toArray();
            if (alreadyBooked.length) {
                const message = `You already have a booking on ${booking.appointmentDate}`;
                return res.send({ acknowledged: false, message });
            }

            const result = await bookingsCollection.insertOne(booking);
            res.send(result);
        });

        // stripe

        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                currency: 'usd',
                amount: amount,
                "payment_method_types": [
                    'card'
                ]
            });
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        })

        // payment

        app.post('/payments', async (req, res) => {
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = { $set: { paid: true, transactionId: payment.transactionId } };
            const updateResult = await bookingsCollection.updateOne(filter, updateDoc,)
            res.send(result);
        })

        // JWT token
        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const user = await usersCollection.findOne({ email });
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1h' })
                return res.send({ accessToken: token });
            }
            res.status(403).send({ accessToken: '' });
        });

        // users
        app.get('/users', async (req, res) => {
            const users = await usersCollection.find({}).toArray();
            res.send(users);
        });

        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const user = await usersCollection.findOne({ email });
            res.send({ isAdmin: user?.role === 'admin' });
        });

        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result);
        });

        app.delete('/delete/:id', async (req, res) => {
            const id = req.params.id;
            const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        })

        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = { $set: { role: 'admin' } }
            const result = await usersCollection.updateOne(filter, updateDoc, { upsert: true });
            res.send(result);
        });

        // app.get('/addPrice', async (req, res) => {
        //     const options = { upsert: true };
        //     const updateDoc = { $set: { price: 99 } }
        //     const result = await appointmentOptionCollection.updateMany({}, updateDoc, options);
        //     res.send(result);
        // })

        // doctors api

        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const result = await doctorsCollection.find({}).toArray();
            res.send(result);
        })

        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        })

        app.delete('/deleteDoctor/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const result = await doctorsCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        })
    }
    finally { }
}
run().catch(console.dir);

app.get('/', async (req, res) => res.send('Doctors portal server is running'));

app.listen(port, _ => console.log(`Server is running on port: ${port}`));