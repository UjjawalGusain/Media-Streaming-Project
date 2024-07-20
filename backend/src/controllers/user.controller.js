import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from "../models/user.model.js";
import { uploadFileToCloudinary } from "../utils/cloudinary.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { isValidEmail, isValidGitHubId } from "../utils/validator.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { OtpVerification } from "../models/otp.model.js";
import { sendOtpVerificationEmail } from "../utils/sendOtpVerificationEmail.js";
import { generateAccessTokenAndRefreshToken } from "../utils/generateAccessTokenAndRefreshToken.js";
import { Project } from "../models/project.model.js";
import nodemailer from "nodemailer";

const registerUser = asyncHandler(async (req, res) => {
  try {
    const {
      username,
      fullname,
      email,
      password,
      githubId,
      position,
      description,
    } = req.body;

    if (
      [
        username,
        fullname,
        email,
        password,
        githubId,
        position,
        description,
      ].some((field) => field?.trim() === "")
    ) {
      throw new ApiError(400, "All fields are required");
    }

    if (!isValidEmail(email)) {
      throw new ApiError(400, "Email not acceptable");
    }

    if (!isValidGitHubId(githubId)) {
      throw new ApiError(400, "Github ID not acceptable");
    }

    const existedUser = await User.findOne({
      $or: [{ username }, { email }, { githubId }],
    });

    if (existedUser) {
      throw new ApiError(409, "Username/email/github already exists");
    }

    let profilePicUrl = "";
    let coverImgUrl = "";

    if (req.files && req.files.profilePic) {
      const profilePicLocalPath = req.files.profilePic[0].path;
      const profilePic = await uploadFileToCloudinary(profilePicLocalPath);
      profilePicUrl = profilePic?.url || "";
    }

    if (req.files && req.files.coverImg) {
      const coverImgLocalPath = req.files.coverImg[0].path;
      const coverImg = await uploadFileToCloudinary(coverImgLocalPath);
      coverImgUrl = coverImg?.url || "";
    }

    const userData = {
      fullname,
      profilePic: profilePicUrl,
      coverImg: coverImgUrl,
      username: username.toLowerCase(),
      email,
      githubId,
      password,
      position,
      description,
    };

    req.userData = userData;

    // Send OTP email
    await sendOtpVerificationEmail(req, res);

    return res
      .status(201)
      .json(new ApiResponse(201, req.userData, "User registered successfully"));
  } catch (error) {
    console.error("Error during registration:", error);
    if (error instanceof ApiError) {
      throw error;
    } else {
      throw new ApiError(500, "Registration failed. Please try again.");
    }
  }
});

const verifyOtp = asyncHandler(async (req, res) => {
  try {
    const userOtp = req.body?.otp;
    const email = req.body?.userData?.email;
    if (!userOtp || !email) {
      throw new ApiError(400, "OTP and user email are required");
    }

    const otpVer = await OtpVerification.findOne({ email });
    if (!otpVer) {
      throw new ApiError(404, "User not found in database");
    }

    const doesOtpMatch = await bcrypt.compare(userOtp, otpVer.otp);
    if (!doesOtpMatch) {
      throw new ApiError(400, "Wrong OTP");
    }

    await OtpVerification.findByIdAndDelete(otpVer._id);

    const newUser = await User.create(req.body.userData);

    return res.status(200).json(new ApiResponse(200, newUser, "OTP verified"));
  } catch (error) {
    console.error("Error verifying OTP:", error);
    if (error instanceof ApiError) {
      throw error;
    } else {
      throw new ApiError(500, "Verification failed. Please try again.");
    }
  }
});

const loginUser = asyncHandler(async (req, res) => {
  // Take data from user (username, password)
  // Take this data from req.body
  // Find the username in the database, if found, check if the password matches
  // If it does not match, throw error
  // Else, generate an access token and a refresh token
  // Send cookies
  // Send success response

  const { email, username, password } = req.body;
  //    console.log(req.body);
  // verifying if all required fields are filled

  if (!((username || email) && password)) {
    throw new ApiError(
      400,
      "One identification field and password field is required"
    );
  }
  //    console.log("Hello");

  const foundUser = await User.findOne({
    $or: [{ username }, { email }],
  });

  // console.log(foundUser)

  if (!foundUser) {
    throw new ApiError(404, "User not found");
  }

  const isPassValid = await foundUser.isPasswordCorrect(password);

  // console.log(isPassValid);

  if (!isPassValid) {
    throw new ApiError(401, "Incorrect Password");
  }

  const { refreshToken, accessToken } =
    await generateAccessTokenAndRefreshToken(foundUser._id);

  const newUser = await User.findById(foundUser._id).select(
    "-password -refreshToken"
  );

  const cookieOption = {
    httpOnly: true,
    secure: true,
  };

  return res
    .status(200)
    .cookie("accessToken", accessToken, cookieOption)
    .cookie("refreshToken", refreshToken, cookieOption)
    .json(
      new ApiResponse(
        200,
        {
          user: newUser,
          accessToken,
          refreshToken,
        },
        "User Logged In Successfully"
      )
    );
});

const logoutUser = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(
    req.user._id,
    {
      $set: {
        refreshToken: undefined,
      },
    },
    {
      new: true,
    }
  );

  const cookieOption = {
    httpOnly: true,
    secure: true,
  };

  return res
    .status(200)
    .clearCookie("refreshToken", cookieOption)
    .clearCookie("accessToken", cookieOption)
    .json(new ApiResponse(200, {}, "User Logged Out Successfully"));
});

const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken =
    req.cookies.refreshToken || req.body.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Unauthorized Access");
  }

  try {
    const decodedToken = jwt.verify(
      incomingRefreshToken,
      process.env.REFRESH_TOKEN_SECRET
    );

    const user = await User.findById(decodedToken?._id);

    if (!user) {
      throw new ApiError(401, "Invalid Refresh Token");
    }

    if (incomingRefreshToken !== user?.refreshToken) {
      throw new ApiError(401, "Refresh token expired or used");
    }

    const { newRefreshToken, accessToken } =
      await generateAccessTokenAndRefreshToken(user._id);

    const cookieOption = {
      httpOnly: true,
      secure: true,
    };

    return res
      .status(200)
      .cookie("accessToken", accessToken, cookieOption)
      .cookie("refreshToken", newRefreshToken, cookieOption)
      .json(
        new ApiResponse(
          200,
          {
            accessToken,
            refreshToken: newRefreshToken,
          },
          "Access Token Refreshed"
        )
      );
  } catch (error) {
    throw new ApiError(401, "Invalid Refresh Token");
  }
});

const fetchUserData = asyncHandler(async (req, res) => {
  const incomingRefreshToken =
    req.cookies.refreshToken || req.body.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Unauthorized Access");
  }

  try {
    const decodedToken = jwt.verify(
      incomingRefreshToken,
      process.env.REFRESH_TOKEN_SECRET
    );

    const user = await User.findById(decodedToken?._id);

    if (!user) {
      throw new ApiError(401, "Invalid Refresh Token");
    }

    if (incomingRefreshToken !== user?.refreshToken) {
      throw new ApiError(401, "Refresh token expired or used");
    }

    // console.log("User: ");
    // console.log(user);
    const {
      fullname,
      profilePic,
      coverImg,
      username,
      email,
      githubId,
      position,
      description,
    } = user;
    const userValues = {
      fullname,
      profilePic,
      coverImg,
      username,
      email,
      githubId,
      position,
      description,
    };
    return res.json(
      new ApiResponse(200, userValues, "User Data Successfully fetched")
    );
  } catch (error) {
    throw new ApiError(401, "Error Fetching Data");
  }
});

const addProject = asyncHandler(async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      throw new ApiError(404, "User not found");
    }

    const projectData = req.body;
    const {
      name,
      repoId,
      url,
      description,
      domain,
      techStack,
      stars,
      ownersUsernames,
    } = projectData;

    const ownerUsernames = ownersUsernames
      .split(",")
      .map((username) => username.trim());
    const techStacks = techStack.split(",").map((tech) => tech.trim());

    // Validate required fields
    if (
      !name ||
      !repoId ||
      !url ||
      !description ||
      !domain ||
      !techStacks ||
      !ownerUsernames
    ) {
      throw new ApiError(400, "Missing required project data");
    }

    // Find owners by usernames
    const owners = await Promise.all(
      ownerUsernames.map(async (ownerUsername) => {
        const user = await User.findOne({ username: ownerUsername });
        if (!user) {
          throw new ApiError(
            404,
            `Owner with username ${ownerUsername} not found`
          );
        }
        return user;
      })
    );

    let videosUrl = [];
    let imagesUrl = [];
    let thumbnailUrl = "";

    // Handle video uploads
    if (req.files && req.files.videos) {
      const videos = req.files.videos;
      videosUrl = await Promise.all(
        videos.map(async (video) => {
          let videoUrl = video.path;
          let videoNew;
          try {
            videoNew = await uploadFileToCloudinary(videoUrl);
          } catch (uploadError) {
            throw new ApiError(
              500,
              `Error uploading video: ${uploadError.message}`
            );
          }
          let videoPath = videoNew?.url || "";
          return videoPath;
        })
      );
    }
    console.log("Reached1");

    // Handle image uploads
    if (req.files && req.files.images) {
      const images = req.files.images;
      imagesUrl = await Promise.all(
        images.map(async (image) => {
          let imageUrl = image.path;
          let imageNew;
          try {
            imageNew = await uploadFileToCloudinary(imageUrl);
          } catch (uploadError) {
            throw new ApiError(
              500,
              `Error uploading image: ${uploadError.message}`
            );
          }
          let imagePath = imageNew?.url || "";
          return imagePath;
        })
      );
    }
    console.log("Reached2");

    // Handle thumbnail upload
    if (req.files && req.files.thumbnail) {
      const thumbnail = req.files.thumbnail;
      const thumbnailPath = thumbnail[0].path;
      console.log("Path: ", thumbnailPath);
      let thumbnailNew;
      try {
        thumbnailNew = await uploadFileToCloudinary(thumbnailPath);
        console.log("Thumbnail new: ", thumbnailNew);
      } catch (uploadError) {
        console.log("Here is the error: ", uploadError);
        throw new ApiError(
          500,
          `Error uploading thumbnail: ${uploadError.message}`
        );
      }
      thumbnailUrl = thumbnailNew?.url || "";
    }
    console.log("Reached3");

    const project = {
      name,
      repoId,
      url,
      description,
      domain,
      techStacks,
      stars,
      owners,
      videos: videosUrl,
      images: imagesUrl,
      thumbnail: thumbnailUrl,
    };

    const newProject = await Project.create(project);
    user.projects.push(newProject._id);
    await user.save();

    return res
      .status(200)
      .json(new ApiResponse(200, newProject, "New project added successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    } else {
      throw new ApiError(500, "Internal Server Error while adding project");
    }
  }
});

const fetchUserProjects = asyncHandler(async (req, res) => {
  try {
    const { username } = req.params;

    const user = await User.findOne({ username }).select(
      "-password -refreshToken"
    );

    if (!user) {
      throw new ApiError(404, `Owner with username ${username} not found`);
    }

    if (!user.projects || user.projects.length === 0) {
      return res.json(
        new ApiResponse(
          200,
          { projectObjects: [] },
          "No projects found for this user"
        )
      );
    }

    const projectObjects = await Promise.all(
      user.projects.map(async (projectId) => {
        try {
          return await Project.findById(projectId);
        } catch (error) {
          console.error(`Project with ID ${projectId} not found`, error);
          return null;
        }
      })
    );

    const validProjects = projectObjects.filter((project) => project !== null);

    // console.log("Valid Projects: ", validProjects);

    return res.json(
      new ApiResponse(
        200,
        { projectObjects: validProjects },
        "User Projects Successfully fetched"
      )
    );
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    } else {
      console.error("Error Fetching User Projects:", error);
      throw new ApiError(500, "Error Fetching User Projects");
    }
  }
});

const fetchProject = asyncHandler(async (req, res) => {
  try {
    const { username, projectName } = req.params;

    const user = await User.findOne({ username }).select(
      "-password -refreshToken"
    );

    if (!user) {
      throw new ApiError(404, `Owner with username ${username} not found`);
    }

    // console.log(user);

    const projectIds = user.projects;

    const projects = await Project.find({ _id: { $in: projectIds } });
    console.log("Project Name: ", username);
    const project = projects.find((project) => project.name === projectName);
    // console.log(project);
    const ownerObjects = await Promise.all(
      project.owners.map(async (ownerId) => {
        try {
          return await User.findById(ownerId).select("-refreshToken -password");
        } catch (error) {
          console.error(`Owner with ID ${ownerId} not found`, error);
          return null;
        }
      })
    );

    const validOwnerObjects = ownerObjects.filter((owner) => owner !== null);
    const projectObject = {
      ...project.toObject(), // Convert the Mongoose document to a plain object
      owners: validOwnerObjects,
    };

    // const validProjects = projectObjects.filter((project) => project !== null);
    // console.log(projectObject);

    return res.json(
      new ApiResponse(200, projectObject, "Project successfully fetched")
    );
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    } else {
      console.error("Error Fetching User Projects:", error);
      throw new ApiError(500, "Error Fetching User Projects");
    }
  }
});

const sendEmail = asyncHandler(async (req, res) => {
  try {
    const { username } = req.params;

    const user = await User.findOne({ username }).select(
      "-password -refreshToken"
    );

    if (!user) {
      throw new ApiError(404, `Owner with username ${username} not found`);
    }

    const userEmail = user.email;
    if (!userEmail) {
      throw new ApiError(404, `Email for username ${username} not found`);
    }

    const { firstName, lastName, email, message } = req.body;

    const transporter = nodemailer.createTransport({
      host: process.env.AUTH_SENDER_HOST,
      auth: {
        user: process.env.AUTH_SENDER_EMAIL,
        pass: process.env.AUTH_SENDER_PASSWORD,
      },
    });

    const mailOptions = {
      from: process.env.AUTH_SENDER_EMAIL,
      to: userEmail,
      subject: "Contact Form Submission",
      html: `
        <p><strong>First Name:</strong> ${firstName}</p>
        <p><strong>Last Name:</strong> ${lastName}</p>
        <p><strong>Email By:</strong> ${email}</p>
        <p><strong>Message:</strong></p>
        <p>${message}</p>
      `,
    };
    await transporter.sendMail(mailOptions);
    // console.log("Email sent successfully");
    return res.json(
      new ApiResponse(200, {success: true}, "Email sent successfully")
    );
  } catch (error) {
    console.error("Error sending email:", error);
    if (error instanceof ApiError) {
      throw error;
    } else {
      throw new ApiError(500, "Error while sending he email.");
    }
  }
});

export {
  registerUser,
  loginUser,
  logoutUser,
  refreshAccessToken,
  verifyOtp,
  fetchUserData,
  addProject,
  fetchUserProjects,
  fetchProject,
  sendEmail,
};
